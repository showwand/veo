import type { Route } from "./routing";
import type { LocationStatus } from "./userLocation";

// ---------- What the top panel shows ----------

export type ManeuverKind =
  | "straight"
  | "left"
  | "right"
  | "slight-left"
  | "slight-right"
  | "u-turn"
  | "roundabout"
  | "arrive";

// One upcoming instruction. These come from OSRM's own steps (see osrmSteps.ts).
export type Maneuver = {
  kind: ManeuverKind;
  instruction: string; // e.g. "Turn left onto Old Kent Road (A2)"
  distanceMeters: number; // distance to the maneuver, from the CURRENT GPS position
};

// ---------- What the GPS navigation engine provides ----------

// Everything is null/false until a real GPS position has been matched to the route.
export type LiveNavigationData = {
  maneuver: Maneuver | null;
  positionMeters: number | null; // how far along the route the car is
  progressFraction: number | null; // the same, as 0..1
  currentSpeedMph: number | null; // GPS speed. NOT the speed limit.
  remainingSeconds: number | null; // from OSRM step durations (no traffic)
  remainingMeters: number | null;
  offRoute: boolean;
  arrived: boolean;
  // false = the last readings did not fit the route (not yet declared "off route"); null = unknown
  positionOnRoute: boolean | null;
  distanceFromRouteM: number | null; // how far the latest reading is from the route line
  gpsStatus: LocationStatus;
  accuracyM: number | null; // accuracy of the latest GPS reading
  updatedAt: number | null; // when this was calculated (ms since 1970)
};

export const NO_LIVE_DATA: LiveNavigationData = {
  maneuver: null,
  positionMeters: null,
  progressFraction: null,
  currentSpeedMph: null,
  remainingSeconds: null,
  remainingMeters: null,
  offRoute: false,
  arrived: false,
  positionOnRoute: null,
  distanceFromRouteM: null,
  gpsStatus: "idle",
  accuracyM: null,
  updatedAt: null,
};

// ---------- Everything the two panels need ----------

export type NavigationSnapshot = {
  route: Route;
  startedAt: number; // when Start was pressed (ms since 1970)

  maneuver: Maneuver | null;
  hasTurnData: boolean; // false if OSRM gave no steps for this route
  currentSpeedMph: number | null; // GPS speed; null = no GPS speed

  speedLimitMph: number | null; // OSM speed limit; null = OSM doesn't say, or not loaded yet
  // "route-start": the limit just after the START of the route (position not known yet)
  // "route-position": the limit where the car really is
  speedLimitSource: "route-start" | "route-position";

  offRoute: boolean;
  arrived: boolean;
  positionOnRoute: boolean | null;
  distanceFromRouteM: number | null;
  gpsStatus: LocationStatus;
  gpsAccuracyM: number | null;

  etaMs: number;
  etaLabel: string; // in the user's own local time format
  remainingMinutes: number;
  // "start-time": estimated duration counted from when Start was pressed (fallback)
  // "route-progress": from how far along the route the car really is
  timingSource: "start-time" | "route-progress";
};