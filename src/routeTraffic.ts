import type { Route, TrafficSegment } from "./routing";
import { buildTrack, pointAt, type RouteTrack } from "./routeMatching";

type TomTomPoint = { latitude?: number; longitude?: number };

type TomTomTrafficSection = {
  startPointIndex?: number;
  endPointIndex?: number;
  sectionType?: string;
  magnitudeOfDelay?: number;
};

type TomTomTrafficRoute = {
  summary?: {
    travelTimeInSeconds?: number;
  };
  legs?: Array<{ points?: TomTomPoint[] }>;
  sections?: TomTomTrafficSection[];
};

type TomTomTrafficResponse = { routes?: TomTomTrafficRoute[] };

const MAX_WAYPOINTS = 20;
const MIN_SAMPLE_SPACING_M = 1000;

function routeWaypoints(track: RouteTrack): [number, number][] {
  if (track.lengthMeters <= 0) return [];
  const interval = Math.max(
    MIN_SAMPLE_SPACING_M,
    track.lengthMeters / (MAX_WAYPOINTS - 1)
  );
  const points: [number, number][] = [];
  for (let distance = 0; distance < track.lengthMeters; distance += interval) {
    const point = pointAt(track, distance);
    if (point) points.push(point);
  }
  const end = track.coords[track.coords.length - 1];
  if (end && points[points.length - 1] !== end) points.push(end);
  return points;
}

function sectionCoordinates(
  trafficTrack: RouteTrack,
  routeTrack: RouteTrack,
  startIndex: number,
  endIndex: number,
): [number, number][] {
  const startDistance = trafficTrack.cumulative[startIndex];
  const endDistance = trafficTrack.cumulative[endIndex];
  if (
    startDistance === undefined ||
    endDistance === undefined ||
    trafficTrack.lengthMeters <= 0 ||
    routeTrack.lengthMeters <= 0
  ) {
    return [];
  }
  const startMeters = (startDistance / trafficTrack.lengthMeters) * routeTrack.lengthMeters;
  const endMeters = (endDistance / trafficTrack.lengthMeters) * routeTrack.lengthMeters;
  if (endMeters <= startMeters) return [];

  const first = pointAt(routeTrack, startMeters);
  const last = pointAt(routeTrack, endMeters);
  if (!first || !last) return [];

  const coordinates: [number, number][] = [first];
  routeTrack.coords.forEach((coordinate, index) => {
    const distance = routeTrack.cumulative[index];
    if (distance !== undefined && distance > startMeters && distance < endMeters) {
      coordinates.push(coordinate);
    }
  });
  coordinates.push(last);
  return coordinates;
}

function parseSegments(
  sections: TomTomTrafficSection[] | undefined,
  trafficTrack: RouteTrack,
  routeTrack: RouteTrack
): TrafficSegment[] {
  if (!sections) return [];
  const segments: TrafficSegment[] = [];

  for (const section of sections) {
    const start = section.startPointIndex;
    const end = section.endPointIndex;
    const severity = section.magnitudeOfDelay;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      typeof severity !== "number" ||
      severity < 1 ||
      severity > 4 ||
      (section.sectionType && !/traffic/i.test(section.sectionType))
    ) {
      continue;
    }
    const coordinates = sectionCoordinates(trafficTrack, routeTrack, start, end);
    if (coordinates.length >= 2) {
      segments.push({ coordinates, magnitudeOfDelay: severity });
    }
  }
  return segments;
}

export async function fetchTomTomTrafficForRoute(
  route: Route,
  apiKey: string,
  signal: AbortSignal
): Promise<Route> {
  const routeTrack = buildTrack(route.geometry.coordinates);
  const waypoints = routeWaypoints(routeTrack);
  if (waypoints.length < 2) {
    throw new Error("Route is too short to check live traffic.");
  }

  const locations = waypoints
    .map(([lon, lat]) => `${lat.toFixed(6)},${lon.toFixed(6)}`)
    .join(":");
  const query = new URLSearchParams({
    traffic: "true",
    routeType: "fastest",
    routeRepresentation: "polyline",
    sectionType: "traffic",
    key: apiKey,
  });
  const response = await fetch(
    `https://api.tomtom.com/routing/1/calculateRoute/${locations}/json?${query}`,
    { signal }
  );
  if (!response.ok) {
    throw new Error(`TomTom traffic routing failed (${response.status}).`);
  }

  const data = (await response.json()) as TomTomTrafficResponse;
  const result = data.routes?.[0];
  const duration = result?.summary?.travelTimeInSeconds;
  const tomTomCoordinates =
    result?.legs
      ?.flatMap((leg) => leg.points ?? [])
      .flatMap((point): [number, number][] =>
        typeof point.longitude === "number" && typeof point.latitude === "number"
          ? [[point.longitude, point.latitude]]
          : []
      ) ?? [];
  const trafficTrack = buildTrack(tomTomCoordinates);

  if (!result || typeof duration !== "number" || !Number.isFinite(duration)) {
    throw new Error("TomTom did not return a traffic-aware route duration.");
  }

  return {
    ...route,
    durationSeconds: duration,
    trafficDataAvailable: true,
    trafficSegments: parseSegments(
      result.sections,
      trafficTrack,
      routeTrack
    ),
  };
}
