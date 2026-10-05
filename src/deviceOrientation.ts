import { useSyncExternalStore } from "react";
import { createStore } from "./store";

// This is the way the DEVICE is physically facing (compass), not the direction of travel.
// idle              not listening
// waiting           listening, no reading yet
// needs-permission  iOS: the user must allow it (needs a tap)
// denied            the user refused
// active            real compass readings are arriving
// relative          readings arrive but have no north reference, so they are NOT a compass
// unsupported       no orientation data at all (most desktops)
export type OrientationStatus =
  | "idle"
  | "waiting"
  | "needs-permission"
  | "denied"
  | "active"
  | "relative"
  | "unsupported";

const statusStore = createStore<OrientationStatus>("idle");
const headingStore = createStore<number | null>(null);

export const getOrientationStatus = statusStore.get;
export const subscribeOrientationStatus = statusStore.subscribe;
export const getDeviceHeading = headingStore.get;
export const subscribeDeviceHeading = headingStore.subscribe;

export function useOrientationStatus(): OrientationStatus {
  return useSyncExternalStore(statusStore.subscribe, statusStore.get);
}

const NO_DATA_TIMEOUT_MS = 4000; // no readings by then = no orientation sensor on this device
const SMOOTHING = 0.3; // 0..1, lower = smoother
const EMIT_INTERVAL_MS = 100; // the marker is updated at most 10 times a second

// iOS 13+ adds this static method; other browsers don't have it
type PermissionApi = { requestPermission?: () => Promise<"granted" | "denied"> };
// iOS Safari adds a ready-made compass heading to the event
type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

let wanted = false;
let attached = false;
let permissionGranted = false;
let smoothed: number | null = null;
let lastEmit = 0;
let loggedFirst = false;
let noDataTimer: ReturnType<typeof setTimeout> | null = null;

function permissionApi(): (typeof DeviceOrientationEvent & PermissionApi) | null {
  if (typeof DeviceOrientationEvent === "undefined") return null;
  const api = DeviceOrientationEvent as typeof DeviceOrientationEvent & PermissionApi;
  return typeof api.requestPermission === "function" ? api : null;
}

// 0 = north, 90 = east, 180 = south, 270 = west. Always 0 to 359.99.
const normalise = (degrees: number) => ((degrees % 360) + 360) % 360;
// Shortest signed turn from one angle to another: 359 -> 1 is +2, not -358
const shortestDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;

// Compass heading of the back of the device, corrected for how it is tilted.
function tiltCompensatedHeading(alpha: number, beta: number, gamma: number): number {
  const rad = Math.PI / 180;
  const x = beta * rad;
  const y = gamma * rad;
  const z = alpha * rad;
  const vx = -Math.cos(z) * Math.sin(y) - Math.sin(z) * Math.sin(x) * Math.cos(y);
  const vy = -Math.sin(z) * Math.sin(y) + Math.cos(z) * Math.sin(x) * Math.cos(y);
  let heading = Math.atan(vx / vy);
  if (vy < 0) heading += Math.PI;
  else if (vx < 0) heading += 2 * Math.PI;
  return normalise(heading * (180 / Math.PI));
}

function readHeading(event: DeviceOrientationEvent): number | null {
  const ios = (event as CompassEvent).webkitCompassHeading;
  if (typeof ios === "number" && Number.isFinite(ios)) return normalise(ios);

  const { alpha, beta, gamma } = event;
  if (alpha === null || beta === null || gamma === null) return null;
  // A relative reading starts at an arbitrary direction. It is NOT a compass, so it is not used.
  if (!event.absolute) return null;
  return tiltCompensatedHeading(alpha, beta, gamma);
}

// DIAGNOSTIC: shows once what kind of orientation data this browser actually sends
function logFirst(event: DeviceOrientationEvent) {
  if (loggedFirst) return;
  loggedFirst = true;
  console.log("Veode heading: first orientation event", {
    type: event.type,
    absolute: event.absolute,
    alpha: event.alpha,
    beta: event.beta,
    gamma: event.gamma,
    iosCompassHeading: (event as CompassEvent).webkitCompassHeading ?? null,
  });
}

function clearNoDataTimer() {
  if (noDataTimer !== null) {
    clearTimeout(noDataTimer);
    noDataTimer = null;
  }
}

function onOrientation(event: Event) {
  if (!(event instanceof DeviceOrientationEvent)) return;
  logFirst(event);

  const raw = readHeading(event);
  if (raw === null) {
    // Readings exist but have no north reference: say so, don't pretend it is a compass
    if (event.alpha !== null && statusStore.get() !== "active") {
      clearNoDataTimer();
      statusStore.set("relative");
    }
    return;
  }

  clearNoDataTimer();
  if (statusStore.get() !== "active") statusStore.set("active");

  smoothed = smoothed === null ? raw : normalise(smoothed + shortestDelta(smoothed, raw) * SMOOTHING);

  const now = performance.now();
  if (now - lastEmit >= EMIT_INTERVAL_MS) {
    lastEmit = now;
    headingStore.set(smoothed);
  }
}

function attach() {
  if (attached) return;
  // Chrome (Android) sends absolute readings on the "absolute" event; iOS uses the plain one
  window.addEventListener("deviceorientationabsolute", onOrientation);
  window.addEventListener("deviceorientation", onOrientation);
  attached = true;
  statusStore.set("waiting");
  clearNoDataTimer();
  noDataTimer = setTimeout(() => {
    if (statusStore.get() === "waiting") statusStore.set("unsupported");
  }, NO_DATA_TIMEOUT_MS);
}

function detach() {
  window.removeEventListener("deviceorientationabsolute", onOrientation);
  window.removeEventListener("deviceorientation", onOrientation);
  attached = false;
  clearNoDataTimer();
  smoothed = null;
  headingStore.set(null);
  statusStore.set("idle");
}

export function startOrientation() {
  wanted = true;
  if (typeof DeviceOrientationEvent === "undefined") {
    statusStore.set("unsupported");
    return;
  }
  if (permissionApi() && !permissionGranted) {
    statusStore.set("needs-permission");
    return;
  }
  attach();
}

export function stopOrientation() {
  wanted = false;
  detach();
}

// MUST be called straight from a tap/click (iOS refuses otherwise).
// On browsers that don't need permission this does nothing.
export async function requestOrientationPermission(): Promise<void> {
  const api = permissionApi();
  if (!api || permissionGranted) return;
  try {
    const result = await api.requestPermission?.();
    if (result === "granted") {
      permissionGranted = true;
      if (wanted) attach();
      else statusStore.set("idle");
    } else {
      statusStore.set("denied");
    }
  } catch {
    statusStore.set("denied");
  }
}