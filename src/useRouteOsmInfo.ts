import { useEffect, useState } from "react";
import type { Route } from "./routing";
import {
  getCachedRouteOsmInfo,
  loadRouteOsmInfo,
  motorwayShare,
  type RouteOsmInfo,
} from "./routeRoadInfo";

export type OsmStatus = "idle" | "loading" | "done" | "error";

// Wait this long after a route is selected before asking Overpass. If the user
// clicks through route cards quickly, only the one they stop on is requested.
const REQUEST_DELAY_MS = 500;

// Remembers which route a result belongs to. info === null means the lookup failed.
type Result = { route: Route; info: RouteOsmInfo | null };

function logSummary(route: Route, info: RouteOsmInfo) {
  const share = motorwayShare(info);
  console.log("Veode OSM:", {
    route: route.name,
    roads: info.roads.length,
    cameras: info.cameras.length,
    matchedPercent: Math.round((info.matchedMeters / Math.max(1, info.routeLengthMeters)) * 100),
    motorwayPercent: share === null ? null : Math.round(share * 100),
  });
}

export function useRouteOsmInfo(route: Route | null): {
  info: RouteOsmInfo | null;
  status: OsmStatus;
} {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!route) return;

    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cached = getCachedRouteOsmInfo(route);

    // TEMPORARY DIAGNOSTICS. If you see this line repeated for the same route
    // without you clicking anything, the route object is changing identity and
    // every change cancels the lookup.
    console.log(
      `Veode cameras: route selected id=${route.id} (${cached ? "cache hit" : "will query Overpass"})`
    );

    if (cached) {
      // Already fetched earlier: no network, no delay
      void Promise.resolve(cached).then((info) => {
        if (cancelled) return;
        console.log(`Veode cameras: served from cache, cameras=${info.cameras.length}`);
        setResult({ route, info });
      });
    } else {
      timer = setTimeout(() => {
        loadRouteOsmInfo(route, controller.signal, (partial) => {
          // Cameras are ready before the roads: show them now
          if (!cancelled) setResult({ route, info: partial });
        })
          .then((info) => {
            if (cancelled) return;
            logSummary(route, info);
            setResult({ route, info });
          })
          .catch((error) => {
            // A cancelled request is intentional, not an error
            if (error instanceof DOMException && error.name === "AbortError") return;
            // An OSM failure must never break the route itself: just no OSM data
            console.warn("Veode OSM: lookup failed", error);
            if (!cancelled) setResult({ route, info: null });
          });
      }, REQUEST_DELAY_MS);
    }

    // Selecting another route (or clearing it) cancels the old lookup
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [route]);

  if (!route) return { info: null, status: "idle" };
  // No answer yet for THIS route, so old cameras are never shown for a new route
  if (!result || result.route !== route) return { info: null, status: "loading" };
  if (result.info === null) return { info: null, status: "error" };
  return { info: result.info, status: "done" };
}