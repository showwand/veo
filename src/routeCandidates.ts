import type { Point, RouteGeometry } from "./routing";
import {
  distanceBetween,
  prepareRoute,
  retraceShare,
  sidePoint,
  type PreparedRoute,
} from "./routeGeometry";
import { parseOsrmSteps, type OsrmLeg, type RouteStep } from "./osrmSteps"; // NEW

const OSRM_URL = "https://router.project-osrm.org/route/v1/driving/";

// ---------- Settings you can tweak later ----------

// How far sideways a forced waypoint sits from the fastest route:
// 18% of the straight-line distance A->B, but never less than 500 m or more than 20 km
const SIDE_OFFSET_FRACTION = 0.18;
const SIDE_OFFSET_MIN_M = 500;
const SIDE_OFFSET_MAX_M = 20000;
// A waypoint must snap to a real road within 30% of that offset (300 m to 5 km).
// If there is no road that close, OSRM refuses the request and we simply skip it.
const SNAP_FRACTION = 0.3;
const SNAP_MIN_M = 300;
const SNAP_MAX_M = 5000;

// Where a candidate came from:
// - "base"        OSRM's own fastest route (and any alternatives it volunteers)
// - "detour"      a route forced through a waypoint beside the fastest route
// - "no-motorway" a route OSRM calculated with motorways switched off
export type CandidateSource = "base" | "detour" | "no-motorway";

// A possible route, before we decide whether it is worth showing
export type Candidate = {
  source: CandidateSource;
  geometry: RouteGeometry;
  distanceMeters: number;
  durationSeconds: number;
  prepared: PreparedRoute; // the geometry, prepared for comparing with other routes
  retrace: number; // share of the route that doubles back over itself (0 to 1)
  steps: RouteStep[]; // NEW: OSRM turn-by-turn steps (empty if OSRM gave none)
};

// The parts of an OSRM route that we use
type OsrmRoute = {
  geometry: RouteGeometry;
  distance: number; // metres
  duration: number; // seconds
  legs?: OsrmLeg[]; // NEW: one leg per stretch between waypoints, each with steps
};

type OsrmOptions = {
  alternatives?: number;
  exclude?: string;
  // One entry per waypoint: how far (metres) it may be moved to reach a road.
  // null means "as far as needed".
  radiuses?: (number | null)[];
};

// ---------- Talking to OSRM ----------

// Asks OSRM for routes through a list of points (start, any waypoints, end)
async function requestOsrmRoutes(
  waypoints: Point[],
  signal: AbortSignal,
  options: OsrmOptions = {}
): Promise<OsrmRoute[]> {
  // OSRM wants longitude first, then latitude. Points are separated by ";"
  const coordinates = waypoints
    .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`)
    .join(";");

  // NEW: steps=true asks OSRM for the turn-by-turn maneuvers as well
  const query = ["overview=full", "geometries=geojson", "steps=true"];
  if (options.alternatives) query.push(`alternatives=${options.alternatives}`);
  if (options.exclude) query.push(`exclude=${options.exclude}`);
  if (options.radiuses) {
    const radiuses = options.radiuses.map((r) =>
      r === null ? "unlimited" : String(Math.round(r))
    );
    query.push(`radiuses=${radiuses.join(";")}`);
  }

  const response = await fetch(`${OSRM_URL}${coordinates}?${query.join("&")}`, {
    signal,
  });
  if (!response.ok) throw new Error(`Routing failed: ${response.status}`);

  const data = (await response.json()) as { code?: string; routes?: OsrmRoute[] };
  if (data.code !== "Ok" || !Array.isArray(data.routes) || data.routes.length === 0) {
    throw new Error(`No route found (${data.code ?? "unknown"})`);
  }
  return data.routes;
}

function makeCandidate(
  source: CandidateSource,
  osrm: OsrmRoute,
  refLat: number
): Candidate {
  const prepared = prepareRoute(osrm.geometry.coordinates, refLat);
  return {
    source,
    geometry: osrm.geometry,
    distanceMeters: osrm.distance,
    durationSeconds: osrm.duration,
    prepared,
    retrace: retraceShare(prepared),
    steps: parseOsrmSteps(osrm.legs, osrm.geometry.coordinates), // NEW
  };
}

// ---------- Generating candidates ----------

// Round 0: the normal request. OSRM's first route is its quickest one; it may
// also volunteer alternatives, which we keep as extra candidates (but never rely on).
// If this request fails there is no route at all, so the error is passed on.
export async function fetchBaseCandidates(
  start: Point,
  end: Point,
  signal: AbortSignal
): Promise<Candidate[]> {
  const routes = await requestOsrmRoutes([start, end], signal, {
    alternatives: 3,
  });
  return routes.map((route) => makeCandidate("base", route, start.lat));
}

export type ExtraOptions = {
  // How far along the fastest route (0 = start, 1 = end) to place waypoints.
  // Each fraction gets one waypoint on the left AND one on the right.
  fractions: number[];
  // Also ask OSRM for a route with motorways switched off?
  includeMotorwayFree: boolean;
};

export type ExtraResult = {
  candidates: Candidate[];
  requestCount: number;
};

// Extra rounds: the motorway-free route plus forced-waypoint detours.
// These are "best effort": if one request fails (for example the server does not
// support a feature, or a waypoint has no road nearby) the others still count.
export async function fetchExtraCandidates(
  start: Point,
  end: Point,
  fastest: Candidate,
  options: ExtraOptions,
  signal: AbortSignal
): Promise<ExtraResult> {
  const refLat = start.lat;
  const jobs: { label: string; run: Promise<Candidate[]> }[] = [];

  if (options.includeMotorwayFree) {
    jobs.push({
      label: "avoid motorways",
      run: requestOsrmRoutes([start, end], signal, { exclude: "motorway" }).then(
        (routes) =>
          routes.slice(0, 1).map((route) => makeCandidate("no-motorway", route, refLat))
      ),
    });
  }

  const straight = distanceBetween(start, end);
  const offset = Math.min(
    SIDE_OFFSET_MAX_M,
    Math.max(SIDE_OFFSET_MIN_M, straight * SIDE_OFFSET_FRACTION)
  );
  const snap = Math.min(SNAP_MAX_M, Math.max(SNAP_MIN_M, offset * SNAP_FRACTION));

  for (const fraction of options.fractions) {
    for (const side of [1, -1] as const) {
      const via = sidePoint(fastest.prepared, fraction, side, offset);
      if (!via) continue;

      jobs.push({
        label: `detour ${fraction} ${side === 1 ? "left" : "right"}`,
        run: requestOsrmRoutes([start, via, end], signal, {
          radiuses: [null, snap, null],
        }).then((routes) =>
          routes.slice(0, 1).map((route) => makeCandidate("detour", route, refLat))
        ),
      });
    }
  }

  const settled = await Promise.allSettled(jobs.map((job) => job.run));

  // If the user searched somewhere else meanwhile, stop quietly.
  // (A cancelled request counts as "failed" above, so we check for that here.)
  signal.throwIfAborted();

  const candidates: Candidate[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      candidates.push(...outcome.value);
    } else {
      console.info(
        `Veode routing: "${jobs[index]?.label}" gave no route (${String(outcome.reason)})`
      );
    }
  });

  return { candidates, requestCount: jobs.length };
}