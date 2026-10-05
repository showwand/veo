import { useSyncExternalStore } from "react";
import { getLocationState, subscribeLocation, type LocationFix } from "./userLocation";
import {
  getDeviceHeading,
  getOrientationStatus,
  subscribeDeviceHeading,
  subscribeOrientationStatus,
  type OrientationStatus,
} from "./deviceOrientation";

// Where the shown direction comes from. The three real sources are never blended.
//   gps       the device REPORTED a direction of travel while moving (coords.heading)
//   movement  worked out from two consecutive GPS positions that really moved
//   compass   the device's physical compass (the way it is facing)
//   none      we don't know. The label says why.
export type HeadingSource = "gps" | "movement" | "compass" | "none";

export type HeadingInfo = {
  degrees: number | null; // 0 = north, 90 = east, 180 = south, 270 = west
  source: HeadingSource;
  label: string; // short text for the badge
};

// Reported GPS heading is only trusted above about walking pace
const GPS_MOVING_MPS = 1;

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export function cardinal(degrees: number): string {
  return POINTS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8] ?? "N";
}

function noneLabel(fix: LocationFix | null, orientation: OrientationStatus): string {
  switch (orientation) {
    case "needs-permission":
      return "Tap locate for compass";
    case "denied":
      return "Compass blocked";
    case "relative":
      return "Compass has no north";
    case "unsupported":
      return fix ? "No compass" : "No position";
    case "waiting":
      return "Reading compass…";
    default:
      return fix ? "Heading unknown" : "No position";
  }
}

function compute(
  fix: LocationFix | null,
  device: number | null,
  orientation: OrientationStatus
): HeadingInfo {
  if (fix) {
    if (fix.headingDeg !== null && (fix.speedMps === null || fix.speedMps >= GPS_MOVING_MPS)) {
      return { degrees: fix.headingDeg, source: "gps", label: "GPS heading" };
    }
    if (fix.movementHeadingDeg !== null) {
      return { degrees: fix.movementHeadingDeg, source: "movement", label: "Movement" };
    }
  }
  if (device !== null) return { degrees: device, source: "compass", label: "Compass" };
  return { degrees: null, source: "none", label: noneLabel(fix, orientation) };
}

// The result is cached so useSyncExternalStore gets the same object until an input changes
let cache: {
  fix: LocationFix | null;
  device: number | null;
  orientation: OrientationStatus;
  info: HeadingInfo;
} | null = null;

export function getHeadingInfo(): HeadingInfo {
  const fix = getLocationState().fix;
  const device = getDeviceHeading();
  const orientation = getOrientationStatus();
  if (
    cache &&
    cache.fix === fix &&
    cache.device === device &&
    cache.orientation === orientation
  ) {
    return cache.info;
  }
  const info = compute(fix, device, orientation);
  cache = { fix, device, orientation, info };
  return info;
}

export function subscribeHeading(listener: () => void): () => void {
  const offs = [
    subscribeLocation(listener),
    subscribeDeviceHeading(listener),
    subscribeOrientationStatus(listener),
  ];
  return () => {
    for (const off of offs) off();
  };
}

export function useHeadingInfo(): HeadingInfo {
  return useSyncExternalStore(subscribeHeading, getHeadingInfo);
}