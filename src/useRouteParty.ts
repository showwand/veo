import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Marker, type Map as MapLibreMap } from "maplibre-gl";
import { avatarSrc } from "./avatars";
import {
  getPartyRouteRace,
  reportPartyRouteProgress,
  type PartyRacer,
} from "./routePartyApi";
import { getLocationState, MAX_USABLE_ACCURACY_M } from "./userLocation";
import type { NavigationSnapshot } from "./navigationTypes";

type Options = {
  mapRef: RefObject<MapLibreMap | null>;
  mapReady: boolean;
  partyId: string | null;
  navigationActive: boolean;
  snapshot: NavigationSnapshot | null;
  userId: string | null;
};

type RaceMarker = { marker: Marker; element: HTMLDivElement };

function formatRemaining(seconds: number): string {
  const totalMinutes = Math.max(0, Math.ceil(seconds / 60));
  if (totalMinutes < 60) return `${totalMinutes} MIN LEFT`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} HR ${minutes} MIN LEFT` : `${hours} HR LEFT`;
}

export function useRouteParty({
  mapRef,
  mapReady,
  partyId,
  navigationActive,
  snapshot,
  userId,
}: Options) {
  const [raceState, setRaceState] = useState<{
    partyId: string;
    racers: PartyRacer[];
    error: string | null;
  } | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const markersRef = useRef(new Map<string, RaceMarker>());
  const snapshotRef = useRef(snapshot);
  const racers = useMemo(
    () => (partyId && raceState?.partyId === partyId ? raceState.racers : []),
    [partyId, raceState]
  );
  const raceError = partyId && raceState?.partyId === partyId ? raceState.error : null;
  const error = progressError ?? raceError;

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    if (!partyId) return;

    let cancelled = false;
    let timer: number | null = null;

    const refresh = async () => {
      const result = await getPartyRouteRace(partyId);
      if (cancelled) return;
      if (result.ok) {
        setRaceState({ partyId, racers: result.data, error: null });
        timer = window.setTimeout(() => void refresh(), 5000);
      } else {
        setRaceState({ partyId, racers: [], error: result.message });
        timer = window.setTimeout(() => void refresh(), 15000);
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [partyId]);

  useEffect(() => {
    if (!partyId || !navigationActive) return;
    let cancelled = false;
    let timer: number | null = null;
    let reportedOptOut = false;

    const publishProgress = async () => {
      const fix = getLocationState().fix;
      const current = snapshotRef.current;
      if (
        !fix ||
        fix.accuracyM > MAX_USABLE_ACCURACY_M ||
        current?.progressFraction === null ||
        current?.progressFraction === undefined ||
        current.route.distanceMeters === null
      ) {
        timer = window.setTimeout(() => void publishProgress(), 15000);
        return;
      }

      const result = await reportPartyRouteProgress(
        partyId,
        fix.lat,
        fix.lon,
        current.progressFraction * current.route.distanceMeters,
        current.remainingMinutes * 60
      );
      if (cancelled) return;
      if (!result.ok && !reportedOptOut) {
        setProgressError(result.message);
        reportedOptOut = true;
      } else if (result.ok) {
        setProgressError(null);
        reportedOptOut = false;
      }
      timer = window.setTimeout(() => void publishProgress(), result.ok ? 15000 : 30000);
    };

    void publishProgress();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [partyId, navigationActive]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !partyId) {
      markersRef.current.forEach(({ marker }) => marker.remove());
      markersRef.current.clear();
      return;
    }

    const next = new Map<string, RaceMarker>();
    for (const racer of racers) {
      if (racer.latitude === null || racer.longitude === null) continue;
      const existing = markersRef.current.get(racer.userId);
      const entry = existing ?? createRaceMarker(map, racer);
      updateRaceMarker(entry, racer, racer.userId === userId);
      entry.marker.setLngLat([racer.longitude, racer.latitude]);
      next.set(racer.userId, entry);
    }
    markersRef.current.forEach((entry, id) => {
      if (!next.has(id)) entry.marker.remove();
    });
    markersRef.current = next;

  }, [mapRef, mapReady, partyId, racers, userId]);

  useEffect(
    () => () => {
      markersRef.current.forEach(({ marker }) => marker.remove());
      markersRef.current.clear();
    },
    [mapRef, mapReady, partyId]
  );

  const orderedRacers = useMemo(
    () =>
      [...racers].sort((a, b) => {
        const progressA = a.progressMeters ?? -1;
        const progressB = b.progressMeters ?? -1;
        return progressB - progressA || a.username.localeCompare(b.username);
      }),
    [racers]
  );

  return { racers: orderedRacers, error };
}

function createRaceMarker(map: MapLibreMap, racer: PartyRacer): RaceMarker {
  const element = document.createElement("div");
  element.className = "route-racer-marker";
  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  image.src = avatarSrc(racer.avatarId);
  const label = document.createElement("span");
  label.textContent = racer.username;
  element.append(image, label);
  const marker = new Marker({ element, anchor: "bottom" }).addTo(map);
  return { marker, element };
}

function updateRaceMarker(entry: RaceMarker, racer: PartyRacer, own: boolean) {
  const image = entry.element.querySelector("img");
  if (image && image.src !== avatarSrc(racer.avatarId)) image.src = avatarSrc(racer.avatarId);
  const label = entry.element.querySelector("span");
  if (label) label.textContent = own ? `${racer.username} · YOU` : racer.username;
  entry.element.title = `${racer.username} · ${
    racer.remainingSeconds === null ? "progress unavailable" : formatRemaining(racer.remainingSeconds)
  }`;
  entry.element.classList.toggle("is-own", own);
}

export { formatRemaining };
