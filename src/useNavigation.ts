import { useEffect, useState, useSyncExternalStore } from "react";
import type { Route } from "./routing";
import { speedLimitAtDistance, type RouteOsmInfo } from "./routeRoadInfo";
import { type LiveNavigationData, type NavigationSnapshot } from "./navigationTypes";
import { NavigationTracker } from "./navigationTracker";
import {
  getLocationState,
  releaseLocation,
  requestLocation,
  subscribeLocation,
} from "./userLocation";

// How often the clock-based numbers (remaining minutes) are refreshed
const TICK_MS = 15000;
// How often the tracker is re-evaluated even without a new GPS reading
// (so old speed values expire and status changes show up)
const REFRESH_MS = 5000;
// How long the exit animation runs before the layout returns to normal
const LEAVE_MS = 600;
// Until we know where the car is, the speed limit is read just after the route's start
const ROUTE_START_PROBE_M = 25;

// off     = normal route selection
// on      = active navigation
// leaving = the exit animation is playing (the data is kept, the panels slide out)
export type NavigationPhase = "off" | "on" | "leaving";

type Session = { route: Route; startedAt: number };

function buildSnapshot(
  session: Session,
  now: number,
  osmInfo: RouteOsmInfo | null,
  live: LiveNavigationData
): NavigationSnapshot {
  const { route, startedAt } = session;

  let etaMs: number;
  let remainingSeconds: number;
  let timingSource: NavigationSnapshot["timingSource"];

  if (live.remainingSeconds !== null && live.updatedAt !== null) {
    // Real route progress is known: arrival = the moment it was measured + the time left
    etaMs = live.updatedAt + live.remainingSeconds * 1000;
    remainingSeconds = Math.max(0, (etaMs - now) / 1000);
    timingSource = "route-progress";
  } else {
    // No position yet: arrival = the moment Start was pressed + the estimated duration
    etaMs = startedAt + route.durationSeconds * 1000;
    remainingSeconds = Math.max(0, (etaMs - now) / 1000);
    timingSource = "start-time";
  }

  // The OSM speed-limit sections are measured along the route by a slightly different
  // ruler than GPS progress, so position is converted through the 0..1 fraction
  const osmPosition =
    osmInfo && live.progressFraction !== null
      ? live.progressFraction * osmInfo.routeLengthMeters
      : null;

  return {
    route,
    startedAt,
    positionMeters: live.positionMeters,
    progressFraction: live.progressFraction,
    maneuver: live.maneuver,
    hasTurnData: (route.steps?.length ?? 0) > 0,
    currentSpeedMph: live.currentSpeedMph,
    // speedLimitAtDistance only returns limits OSM states in mph; otherwise null (never invented)
    speedLimitMph: osmInfo ? speedLimitAtDistance(osmInfo, osmPosition ?? ROUTE_START_PROBE_M) : null,
    speedLimitSource: osmPosition !== null ? "route-position" : "route-start",
    offRoute: live.offRoute,
    arrived: live.arrived,
    positionOnRoute: live.positionOnRoute,
    distanceFromRouteM: live.distanceFromRouteM,
    gpsStatus: live.gpsStatus,
    gpsAccuracyM: live.accuracyM,
    etaMs,
    // The user's own locale and clock: "2:25 PM" or "14:25"
    etaLabel: new Date(etaMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    remainingMinutes: Math.ceil(remainingSeconds / 60),
    timingSource,
  };
}

// Owns the navigation state. MapView passes in the OSM info of the selected route
// (for the speed limit). GPS comes from the shared location service.
export function useNavigation(osmInfo: RouteOsmInfo | null) {
  const [phase, setPhase] = useState<NavigationPhase>("off");
  const [session, setSession] = useState<Session | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The engine that turns GPS readings into progress, instructions, ETA, off-route and arrival
  const [tracker] = useState(() => new NavigationTracker());
  const live = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);

  const active = phase === "on";

  // Refresh the clock while navigating so "remaining minutes" counts down
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  // While navigating, every GPS reading goes to the engine
  useEffect(() => {
    if (!active || !session) return;
    tracker.begin(session.route);
    const unsubscribe = subscribeLocation(() => tracker.ingest(getLocationState()));
    const refresh = setInterval(() => tracker.ingest(getLocationState()), REFRESH_MS);
    tracker.ingest(getLocationState());
    return () => {
      unsubscribe();
      clearInterval(refresh);
      tracker.end();
    };
  }, [active, session, tracker]);

  function start(route: Route) {
    const startedAt = Date.now();
    // Called from the Start click, so the browser's location prompt is allowed to appear
    requestLocation("navigation");
    setSession({ route, startedAt });
    setNow(startedAt);
    setPhase("on");
  }

  function end() {
    releaseLocation("navigation");
    setPhase((current) => (current === "on" ? "leaving" : current));
    // The session is kept (the route data is not destroyed), so the panels can
    // still show their content while they slide out
    window.setTimeout(() => {
      setPhase((current) => (current === "leaving" ? "off" : current));
    }, LEAVE_MS);
  }

  const snapshot = session ? buildSnapshot(session, now, osmInfo, live) : null;

  return { phase, active, snapshot, start, end };
}