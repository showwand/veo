import {
  fetchBaseCandidates,
  fetchExtraCandidates,
  type Candidate,
} from "./routeCandidates";
import { classifyRoutes } from "./routeScoring";
import type { RouteStep } from "./osrmSteps";
import { fetchWalkingRoute } from "./walkingRouting";
import { fetchPublicTransportRoutes } from "./transitRouting";

// A point on the map. Your SearchResult objects already fit this shape.
export type Point = { lat: number; lon: number };
export type TravelMode = "car" | "public-transport" | "walking";

// The line OSRM gives us, in GeoJSON format: a list of [longitude, latitude] pairs
export type RouteGeometry = {
  type: "LineString";
  coordinates: [number, number][];
};

// Every kind of route Veode will eventually offer.
// "fastest", "avoid-motorways" and "alternative" are built so far;
// "scenic" and "fun" are waiting for OpenStreetMap-based scoring (see routeScoring.ts).
export type RouteType =
  | "fastest"
  | "scenic"
  | "avoid-motorways"
  | "fun"
  | "alternative";

// One route option the user can choose between
export type Route = {
  id: string; // unique, e.g. "fastest"
  name: string; // what the user sees, e.g. "Fastest"
  type: RouteType;
  mode: TravelMode;
  geometry: RouteGeometry;
  distanceMeters: number | null;
  durationSeconds: number;
  details?: string | null;
  // [west, south, east, north] - a box around the whole route, used to zoom the map
  bounds: [number, number, number, number];
  // OSRM's turn-by-turn steps for this route. Empty if OSRM gave none.
  steps?: RouteStep[];
};

// If the first round finds fewer than this many different routes, we try more detours
const WANTED_OPTIONS = 3;

// routeScoring.ts builds the Route cards; this puts each candidate's steps onto its card.
// A card and its candidate share the very same geometry object, which is how they are paired.
function withSteps(routes: Route[], candidates: Candidate[]): Route[] {
  return routes.map((route) => ({
    ...route,
    steps: candidates.find((c) => c.geometry === route.geometry)?.steps ?? [],
  }));
}

// The ONE function the rest of the app uses to get route options.
// The work is split into steps, each in its own file:
//   routeCandidates.ts  asks OSRM for many possible routes
//   routeGeometry.ts    measures routes and compares them
//   routeScoring.ts     throws out copies and decides which route is which
export async function fetchRouteOptions(
  start: Point,
  end: Point,
  mode: TravelMode,
  signal: AbortSignal
): Promise<Route[]> {
  if (mode === "walking") return fetchWalkingRoute(start, end, signal);
  if (mode === "public-transport") {
    return fetchPublicTransportRoutes(start, end, signal);
  }

  // Round 0: the normal request. If this fails there is no route at all.
  const base = await fetchBaseCandidates(start, end, signal);
  const fastestGuess = base[0]; // OSRM puts its quickest route first
  if (!fastestGuess) throw new Error("No route found");

  // Round 1: the motorway-free route and two detours (left and right of the middle)
  const round1 = await fetchExtraCandidates(
    start,
    end,
    fastestGuess,
    { fractions: [0.5], includeMotorwayFree: true },
    signal
  );
  let candidates = [...base, ...round1.candidates];
  let requests = 1 + round1.requestCount;
  let routes = classifyRoutes(candidates);

  // Round 2 (only if needed): four more detours, nearer the start and the end
  if (routes.length < WANTED_OPTIONS) {
    const round2 = await fetchExtraCandidates(
      start,
      end,
      fastestGuess,
      { fractions: [0.3, 0.7], includeMotorwayFree: false },
      signal
    );
    candidates = [...candidates, ...round2.candidates];
    requests += round2.requestCount;
    routes = classifyRoutes(candidates);
  }

  // A note for you: open the browser console (F12) to see this line
  console.log("Veode routing:", {
    osrmRequests: requests,
    candidates: candidates.length,
    shown: routes.map((route) => route.name),
  });

  return withSteps(routes, candidates);
}

// 2520 seconds -> "42 min", 5100 seconds -> "1 h 25 min"
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

// 18400 metres -> "18.4 km / 11.4 miles"
export function formatDistance(meters: number): string {
  const km = meters / 1000;
  const miles = km * 0.621371;
  return `${km.toFixed(1)} km / ${miles.toFixed(1)} miles`;
}