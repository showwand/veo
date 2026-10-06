import { useEffect, useRef, useState, type RefObject } from "react";
import { Marker, Popup, type Map as MapLibreMap } from "maplibre-gl";
import { useAccountState } from "./accountStore";
import { listFriends } from "./friendsApi";
import { asNumber, asString, isRecord } from "./dbParse";
import { avatarSrc } from "./avatars";
import { supabase } from "./supabaseClient";
import { distanceBetween } from "./routeGeometry";
import {
  getLocationState,
  releaseLocation,
  requestLocation,
  subscribeLocation,
  type LocationFix,
} from "./userLocation";

const STALE_AFTER_MS = 3 * 60 * 1000;
const PUBLISH_MS = 15 * 1000;
const MIN_PUBLISH_MOVE_M = 25;

type FriendLocation = {
  id: string;
  username: string;
  avatarId: string;
  lat: number;
  lon: number;
  accuracyM: number;
  headingDeg: number | null;
  speedMps: number | null;
  updatedAt: number;
  stale: boolean;
};

type FriendLocationRow = {
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  updated_at: string;
};

type MarkerEntry = {
  marker: Marker;
  popup: Popup;
  root: HTMLDivElement;
  update: (friend: FriendLocation) => void;
  remove: () => void;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeLabel(updatedAt: number): string {
  const diff = Date.now() - updatedAt;
  if (diff < 60_000) return "Updated just now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `Updated ${hours} hr ago`;
}

function parseLocationRow(row: unknown): FriendLocationRow | null {
  if (!isRecord(row)) return null;
  const userId = asString(row.user_id);
  const latitude = asNumber(row.latitude);
  const longitude = asNumber(row.longitude);
  const accuracy = asNumber(row.accuracy);
  const heading = asNumber(row.heading);
  const speed = asNumber(row.speed);
  const updatedAt = asString(row.updated_at);
  if (userId === null || latitude === null || longitude === null || updatedAt === null) return null;
  return {
    user_id: userId,
    latitude,
    longitude,
    accuracy: accuracy ?? null,
    heading: heading ?? null,
    speed: speed ?? null,
    updated_at: updatedAt,
  };
}

function createMarkerEntry(map: MapLibreMap, friend: FriendLocation): MarkerEntry {
  const root = document.createElement("div");
  root.className = "friend-marker";
  const image = document.createElement("img");
  image.className = "friend-avatar";
  image.src = avatarSrc(friend.avatarId);
  image.alt = friend.username;
  image.draggable = false;
  const label = document.createElement("span");
  label.className = "friend-label";
  label.textContent = friend.username;
  root.append(image, label);

  const marker = new Marker({ element: root, anchor: "center" });
  const popup = new Popup({
    closeButton: true,
    closeOnClick: true,
    offset: 18,
    className: "veode-popup friend-popup-wrap",
  });
  let currentFriend = friend;
  let pinned = false;
  popup.on("close", () => {
    pinned = false;
  });

  const showPopup = () => {
    const current = currentFriend;
    const html = `
      <div class="friend-popup">
        <div class="friend-popup-name">${escapeHtml(current.username)}</div>
        <div class="friend-popup-handle">@${escapeHtml(current.username)}</div>
        <div class="friend-popup-time">${timeLabel(current.updatedAt)}</div>
      </div>
    `;
    popup.setLngLat([current.lon, current.lat]).setHTML(html).addTo(map);
  };

  const update = (next: FriendLocation) => {
    currentFriend = next;
    marker.setLngLat([next.lon, next.lat]);
    const stale = next.stale;
    image.src = avatarSrc(next.avatarId);
    image.alt = next.username;
    label.textContent = next.username;
    root.title = `${next.username} - shared location`;
    root.setAttribute("aria-label", `${next.username}'s shared location`);
    root.classList.toggle("is-stale", stale);
    root.classList.toggle("is-live", !stale);
    root.dataset.friendId = next.id;
  };

  root.tabIndex = 0;
  root.setAttribute("role", "button");
  root.addEventListener("mouseenter", showPopup);
  root.addEventListener("mouseleave", () => {
    if (!pinned) popup.remove();
  });
  root.addEventListener("focus", showPopup);
  root.addEventListener("blur", () => {
    if (!pinned) popup.remove();
  });
  root.addEventListener("click", (event) => {
    event.stopPropagation();
    pinned = !pinned;
    if (pinned) showPopup();
    else popup.remove();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    pinned = !pinned;
    if (pinned) showPopup();
    else popup.remove();
  });

  marker.addTo(map);
  update(friend);

  return {
    marker,
    popup,
    root,
    update,
    remove() {
      popup.remove();
      marker.remove();
    },
  };
}

async function deleteOwnLocation(userId: string) {
  if (!supabase) return;
  const { error } = await supabase.from("user_locations").delete().eq("user_id", userId);
  if (error) console.warn("Veode location: could not clear shared location", error);
}

async function upsertOwnLocation(userId: string, fix: LocationFix) {
  if (!supabase) return;
  const payload = {
    user_id: userId,
    latitude: fix.lat,
    longitude: fix.lon,
    accuracy: fix.accuracyM,
    heading: fix.headingDeg,
    speed: fix.speedMps,
    updated_at: new Date(fix.timestamp).toISOString(),
  };
  const { error } = await supabase.from("user_locations").upsert(payload, { onConflict: "user_id" });
  if (error) console.warn("Veode location: could not publish shared location", error);
}

export function useLocationSharing() {
  const account = useAccountState();
  const enabled = account.profile?.shareLocation ?? false;
  const activeId = account.activeId;
  const lastPublishedRef = useRef<{ at: number; fix: LocationFix } | null>(null);

  useEffect(() => {
    lastPublishedRef.current = null;
    if (!supabase || !activeId) {
      releaseLocation("share");
      return;
    }

    if (!enabled) {
      void deleteOwnLocation(activeId);
      releaseLocation("share");
      return;
    }

    requestLocation("share");

    const publish = () => {
      const state = getLocationState();
      const fix = state.fix;
      if (!fix) return;
      const now = Date.now();
      const last = lastPublishedRef.current;
      if (!last) {
        void upsertOwnLocation(activeId, fix);
        lastPublishedRef.current = { at: now, fix };
        return;
      }
      const moved = distanceBetween(
        { lat: last.fix.lat, lon: last.fix.lon },
        { lat: fix.lat, lon: fix.lon }
      );
      if (now - last.at >= PUBLISH_MS || moved >= MIN_PUBLISH_MOVE_M) {
        void upsertOwnLocation(activeId, fix);
        lastPublishedRef.current = { at: now, fix };
      }
    };

    publish();
    const unsubscribe = subscribeLocation(publish);
    return () => {
      unsubscribe();
      releaseLocation("share");
    };
  }, [enabled, activeId]);
}

export function useFriendLocations(
  mapRef: RefObject<MapLibreMap | null>,
  mapReady: boolean,
  excludedFriendIds: ReadonlySet<string> = new Set()
) {
  const account = useAccountState();
  const markersRef = useRef<globalThis.Map<string, MarkerEntry>>(new globalThis.Map());
  const [friends, setFriends] = useState<FriendLocation[]>([]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      markersRef.current.forEach((entry) => entry.remove());
      markersRef.current.clear();
      return;
    }

    const client = supabase;
    if (!client || !account.activeId) {
      markersRef.current.forEach((entry) => entry.remove());
      markersRef.current.clear();
      return;
    }

    let cancelled = false;

    async function refresh() {
      if (!client) return;
      const friendsResult = await listFriends();
      if (cancelled || !friendsResult.ok) return;

      const friendIds = friendsResult.data.map((friend) => friend.id);
      if (friendIds.length === 0) {
        setFriends([]);
        return;
      }

      const { data, error } = await client
        .from("user_locations")
        .select("user_id, latitude, longitude, accuracy, heading, speed, updated_at")
        .in("user_id", friendIds);

      if (cancelled) return;
      if (error) {
        console.warn("Veode friend locations: could not fetch shared positions", error);
        setFriends([]);
        return;
      }

      const byUserId = new globalThis.Map<string, FriendLocationRow>();
      for (const row of data ?? []) {
        const parsed = parseLocationRow(row);
        if (parsed) byUserId.set(parsed.user_id, parsed);
      }

      const nextFriends: FriendLocation[] = [];
      for (const friend of friendsResult.data) {
        const location = byUserId.get(friend.id);
        if (!location) continue;
        const updatedAt = Date.parse(location.updated_at);
        if (Number.isNaN(updatedAt)) continue;
        const stale = Date.now() - updatedAt > STALE_AFTER_MS;
        nextFriends.push({
          id: friend.id,
          username: friend.username,
          avatarId: friend.avatarId,
          lat: location.latitude,
          lon: location.longitude,
          accuracyM: location.accuracy ?? 9999,
          headingDeg: location.heading ?? null,
          speedMps: location.speed ?? null,
          updatedAt,
          stale,
        });
      }

      setFriends(nextFriends.filter((friend) => !excludedFriendIds.has(friend.id)));
    }

    void refresh();

    const channel = client.channel(`friend-locations-${account.activeId}`);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "user_locations" },
      () => {
        if (!cancelled) void refresh();
      }
    );
    channel.subscribe();

    return () => {
      cancelled = true;
      channel.unsubscribe();
    };
  }, [account.activeId, excludedFriendIds, mapReady, mapRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const next = new globalThis.Map<string, MarkerEntry>();
    for (const friend of friends) {
      const existing = markersRef.current.get(friend.id);
      if (existing) {
        existing.update(friend);
        next.set(friend.id, existing);
      } else {
        next.set(friend.id, createMarkerEntry(map, friend));
      }
    }

    for (const [id, entry] of markersRef.current.entries()) {
      if (!next.has(id)) {
        entry.remove();
      }
    }

    markersRef.current = next;
  }, [friends, mapReady, mapRef]);
}
