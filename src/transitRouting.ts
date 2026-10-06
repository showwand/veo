import type { Point, Route } from "./routing";
import { decodeRouteLine, isRecord, makeProviderRoute } from "./routeProviderUtils";

const TFL_API = "https://api.tfl.gov.uk";
const TFL_APP_KEY: unknown = import.meta.env.VITE_TFL_APP_KEY;

function readDistance(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function routeCoordinates(legs: unknown[]): [number, number][] {
  const coordinates: [number, number][] = [];
  for (const leg of legs) {
    if (!isRecord(leg) || !isRecord(leg.path)) continue;
    const points = decodeRouteLine(leg.path.lineString);
    for (const point of points) {
      const previous = coordinates[coordinates.length - 1];
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) {
        coordinates.push(point);
      }
    }
  }
  return coordinates;
}

function transportDetails(legs: unknown[]): string | null {
  const modes = new Set<string>();
  for (const leg of legs) {
    if (!isRecord(leg) || !isRecord(leg.mode)) continue;
    if (typeof leg.mode.name === "string" && leg.mode.name.trim()) {
      modes.add(leg.mode.name.trim());
    }
  }
  return modes.size > 0
    ? [...modes].map((mode) => mode[0]?.toUpperCase() + mode.slice(1)).join(" + ")
    : null;
}

export async function fetchPublicTransportRoutes(
  start: Point,
  end: Point,
  signal: AbortSignal
): Promise<Route[]> {
  if (typeof TFL_APP_KEY !== "string" || !TFL_APP_KEY.trim()) {
    throw new Error(
      "Public transport routing needs a TfL API key. Add VITE_TFL_APP_KEY to your local environment and rebuild."
    );
  }

  const url = new URL(
    `${TFL_API}/Journey/JourneyResults/${start.lat},${start.lon}/to/${end.lat},${end.lon}`
  );
  url.searchParams.set("app_key", TFL_APP_KEY.trim());

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`TfL journey search failed (${response.status}).`);
  const payload: unknown = await response.json();
  const journeys =
    isRecord(payload) && Array.isArray(payload.journeys) ? payload.journeys : [];

  const routes: Route[] = [];
  for (const [index, rawJourney] of journeys.entries()) {
    if (!isRecord(rawJourney) || !Array.isArray(rawJourney.legs)) continue;
    const legs: unknown[] = rawJourney.legs;
    const coordinates = routeCoordinates(legs);
    const durationMinutes = rawJourney.duration;
    if (
      coordinates.length < 2 ||
      typeof durationMinutes !== "number" ||
      !Number.isFinite(durationMinutes) ||
      durationMinutes <= 0
    ) {
      continue;
    }
    const legDistances = legs.map((leg) =>
      isRecord(leg) ? readDistance(leg.distance) : null
    );
    const distanceMeters =
      legDistances.length > 0 && legDistances.every((distance) => distance !== null)
        ? legDistances.reduce<number>((total, distance) => total + (distance ?? 0), 0)
        : null;
    routes.push(
      makeProviderRoute(
        `tfl-${index + 1}`,
        `Journey ${index + 1}`,
        "public-transport",
        coordinates,
        distanceMeters,
        durationMinutes * 60,
        transportDetails(legs)
      )
    );
  }

  if (routes.length === 0) {
    throw new Error("TfL returned no usable public transport journeys for these places.");
  }
  return routes;
}
