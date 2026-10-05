import { useSyncExternalStore } from "react";
import { createStore } from "./store";
import { distanceBetween } from "./routeGeometry";

// idle         not watching
// acquiring    watching, no position yet
// active       receiving positions
// delayed      an error happened after the last position, which is still being used
// lost         errors for a long time: the last known position is still shown
// unavailable  no position yet, and the browser says it can't get one
// denied       the user (or browser) blocked location
// unsupported  this browser has no geolocation
export type LocationStatus =
  | "idle"
  | "acquiring"
  | "active"
  | "delayed"
  | "lost"
  | "unavailable"
  | "denied"
  | "unsupported";

export type LocationFix = {
  lat: number; // exactly coords.latitude
  lon: number; // exactly coords.longitude
  accuracyM: number;
  speedMps: number | null; // null when the device doesn't report speed
  headingDeg: number | null; // direction of travel as REPORTED by the device (coords.heading)
  // Direction of travel worked out from the previous position to this one.
  // null unless this reading really moved. Separate from headingDeg and from the compass.
  movementHeadingDeg: number | null;
  timestamp: number; // the reading's own timestamp
};

export type LocationState = {
  status: LocationStatus;
  fix: LocationFix | null;
  receivedAt: number | null; // when WE received the latest reading
  watching: boolean;
  error: string | null;
};

export type LocationReason = "view" | "navigation" | "share" | "search";

// Readings less accurate than this are shown, but not used to follow the route
export const MAX_USABLE_ACCURACY_M = 200;
// A reading whose own timestamp is older than this when it ARRIVES is ignored
const MAX_FIX_AGE_ON_ARRIVAL_MS = 30000;
// After an error, the last position is still used for this long before we say "lost"
const LOST_AFTER_MS = 45000;
// Movement smaller than this (or half the GPS accuracy) is treated as GPS wobble
const MIN_MOVE_M = 10;

// No "timeout": a stationary receiver is normal, and a timeout would turn that into errors.
// maximumAge 0: never accept a cached position.
const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0 };

const store = createStore<LocationState>({
  status: "idle",
  fix: null,
  receivedAt: null,
  watching: false,
  error: null,
});

export const getLocationState = store.get;
export const subscribeLocation = store.subscribe;

const reasons = new Set<LocationReason>();
let lostTimer: ReturnType<typeof setTimeout> | null = null;

// The watcher id is kept on globalThis, so a hot reload (which re-runs this file)
// can still find and clear a watcher the previous copy started.
type GeoGlobals = typeof globalThis & { __veodeGeoWatchId?: number };
const globals = globalThis as GeoGlobals;

function patch(change: Partial<LocationState>) {
  store.set({ ...store.get(), ...change });
}

function bearingDegrees(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const rad = Math.PI / 180;
  const dLon = (b.lon - a.lon) * rad;
  const y = Math.sin(dLon) * Math.cos(b.lat * rad);
  const x =
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(dLon);
  // 0 = north, 90 = east, 180 = south, 270 = west
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function clearLostTimer() {
  if (lostTimer !== null) {
    clearTimeout(lostTimer);
    lostTimer = null;
  }
}

function onPosition(position: GeolocationPosition) {
  const c = position.coords;
  const now = Date.now();
  const previous = store.get().fix;

  if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
  if (previous && position.timestamp < previous.timestamp) {
    console.log("Veode location: ignored an older, out-of-order reading");
    return;
  }
  if (now - position.timestamp > MAX_FIX_AGE_ON_ARRIVAL_MS) {
    console.log("Veode location: ignored a reading that was already old on arrival");
    return;
  }

  const accuracyM = Number.isFinite(c.accuracy) ? c.accuracy : 9999;
  const speedMps = c.speed !== null && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
  const headingDeg =
    c.heading !== null && Number.isFinite(c.heading) ? ((c.heading % 360) + 360) % 360 : null;
  const here = { lat: c.latitude, lon: c.longitude };

  let moved = 0;
  let movementHeadingDeg: number | null = null;
  if (previous) {
    moved = distanceBetween(previous, here);
    const minMove = Math.max(MIN_MOVE_M, Math.min(previous.accuracyM, accuracyM, 60) * 0.5);
    if (moved >= minMove) movementHeadingDeg = bearingDegrees(previous, here);
  }

  // The very same reading again: nothing to do
  if (
    previous &&
    moved === 0 &&
    previous.accuracyM === accuracyM &&
    previous.timestamp === position.timestamp
  ) {
    return;
  }

  const fix: LocationFix = {
    lat: here.lat,
    lon: here.lon,
    accuracyM,
    speedMps,
    headingDeg,
    movementHeadingDeg,
    timestamp: position.timestamp,
  };

  clearLostTimer();
  store.set({ status: "active", fix, receivedAt: now, watching: true, error: null });

  // One concise line per meaningful update (not per heartbeat)
  if (!previous || moved >= 1 || Math.abs(previous.accuracyM - accuracyM) >= 5) {
    console.log("Veode location:", {
      lat: Number(fix.lat.toFixed(6)),
      lon: Number(fix.lon.toFixed(6)),
      accuracyM: Math.round(accuracyM),
      timestamp: new Date(fix.timestamp).toISOString(),
      speedMps: fix.speedMps,
      headingDeg: fix.headingDeg,
      movedM: Math.round(moved),
    });
  }
}

function onError(error: GeolocationPositionError) {
  if (error.code === error.PERMISSION_DENIED) {
    clearWatcher();
    store.set({
      status: "denied",
      fix: null,
      receivedAt: null,
      watching: false,
      error: error.message,
    });
    return;
  }

  const reason = error.code === error.TIMEOUT ? "timeout" : "position unavailable";
  console.warn(`Veode location: ${reason} (${error.message})`);

  const state = store.get();
  if (!state.fix || state.receivedAt === null) {
    patch({ status: "unavailable", error: reason });
    return;
  }

  // We still have a position: keep using it. Only call it "lost" after a long time.
  const age = Date.now() - state.receivedAt;
  if (age >= LOST_AFTER_MS) {
    patch({ status: "lost", error: reason });
    return;
  }
  patch({ status: "delayed", error: reason });
  clearLostTimer();
  lostTimer = setTimeout(() => {
    if (store.get().status === "delayed") patch({ status: "lost" });
  }, LOST_AFTER_MS - age);
}

function clearWatcher() {
  const id = globals.__veodeGeoWatchId;
  if (id !== undefined) {
    navigator.geolocation.clearWatch(id);
    globals.__veodeGeoWatchId = undefined;
    console.log(`Veode location: watcher stopped (id ${id})`);
  }
  clearLostTimer();
}

function startWatcher() {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    patch({ status: "unsupported" });
    return;
  }
  clearWatcher(); // never two watchers: remove any left over first
  const state = store.get();
  patch({ watching: true, error: null, status: state.fix ? state.status : "acquiring" });
  const id = navigator.geolocation.watchPosition(onPosition, onError, WATCH_OPTIONS);
  globals.__veodeGeoWatchId = id;
  console.log(`Veode location: watcher started (id ${id})`);
}

function stopWatcher() {
  clearWatcher();
  store.set({ status: "idle", fix: null, receivedAt: null, watching: false, error: null });
}

function sync() {
  const wanted = reasons.size > 0;
  const running = globals.__veodeGeoWatchId !== undefined;
  if (wanted && !running) startWatcher();
  else if (!wanted && running) stopWatcher();
}

// Both the normal map view and navigation call these. There is only ever ONE watcher.
export function requestLocation(reason: LocationReason) {
  reasons.add(reason);
  sync();
}

export function releaseLocation(reason: LocationReason) {
  reasons.delete(reason);
  sync();
}

// A position exists and is accurate enough to follow
export function hasUsableFix(): boolean {
  const fix = store.get().fix;
  return fix !== null && fix.accuracyM <= MAX_USABLE_ACCURACY_M;
}

export function useLocationStatus(): LocationStatus {
  return useSyncExternalStore(subscribeLocation, () => store.get().status);
}

export function useLocationWatching(): boolean {
  return useSyncExternalStore(subscribeLocation, () => store.get().watching);
}