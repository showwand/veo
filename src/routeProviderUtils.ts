import { getBounds } from "./routeGeometry";
import type { Route, RouteGeometry, TravelMode } from "./routing";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const coordinates: [number, number][] = [];
  const factor = 10 ** precision;
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    const deltas: number[] = [];
    for (let axis = 0; axis < 2; axis++) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= encoded.length || shift > 30) {
          throw new Error("The routing service returned an invalid route shape.");
        }
        byte = encoded.charCodeAt(index++) - 63;
        if (byte < 0 || byte > 63) {
          throw new Error("The routing service returned an invalid route shape.");
        }
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      deltas.push((result & 1) !== 0 ? ~(result >> 1) : result >> 1);
    }
    latitude += deltas[0] ?? 0;
    longitude += deltas[1] ?? 0;
    coordinates.push([longitude / factor, latitude / factor]);
  }

  return coordinates;
}

function coordinatesFromJson(value: unknown): [number, number][] {
  let points: unknown = value;
  if (isRecord(points) && points.type === "LineString") points = points.coordinates;
  if (!Array.isArray(points)) return [];

  return points.flatMap((point): [number, number][] => {
    if (Array.isArray(point) && point.length >= 2) {
      const lon = Number(point[0]);
      const lat = Number(point[1]);
      return Number.isFinite(lon) && Number.isFinite(lat) ? [[lon, lat]] : [];
    }
    if (isRecord(point)) {
      const lon = Number(point.lon ?? point.longitude);
      const lat = Number(point.lat ?? point.latitude);
      return Number.isFinite(lon) && Number.isFinite(lat) ? [[lon, lat]] : [];
    }
    return [];
  });
}

export function decodeRouteLine(value: unknown, precision = 5): [number, number][] {
  if (typeof value !== "string" || value.length === 0) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return coordinatesFromJson(JSON.parse(trimmed) as unknown);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return [];
    }
  }
  return decodePolyline(trimmed, precision);
}

export function makeProviderRoute(
  id: string,
  name: string,
  mode: TravelMode,
  coordinates: [number, number][],
  distanceMeters: number | null,
  durationSeconds: number,
  details: string | null = null
): Route {
  if (coordinates.length < 2) {
    throw new Error("The routing service did not return a usable route shape.");
  }
  const geometry: RouteGeometry = { type: "LineString", coordinates };
  return {
    id,
    name,
    type: "fastest",
    mode,
    geometry,
    distanceMeters,
    durationSeconds,
    details,
    bounds: getBounds(coordinates),
  };
}
