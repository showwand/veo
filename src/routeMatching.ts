import { distanceBetween, type Coord } from "./routeGeometry";

const EARTH_RADIUS_M = 6371000;
const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

// When we already know roughly where the car is, only the stretch around it is searched
const WINDOW_BACK_M = 300;
const WINDOW_AHEAD_M = 3000;
const WINDOW_ACCEPT_M = 60;

export type RouteTrack = {
  coords: Coord[];
  cumulative: number[]; // metres from the route start to each point
  lengthMeters: number;
};

export type RouteMatch = {
  progressMeters: number; // how far along the route the nearest point is
  distanceM: number; // how far the position is from the route line
  segmentIndex: number;
  bearingDeg: number; // direction the route is heading at that point
};

function metres(a: Coord, b: Coord): number {
  return distanceBetween({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });
}

export function buildTrack(coords: Coord[]): RouteTrack {
  const cumulative: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const before = cumulative[i - 1] ?? 0;
    cumulative.push(a && b ? before + metres(a, b) : before);
  }
  return { coords, cumulative, lengthMeters: cumulative[cumulative.length - 1] ?? 0 };
}

// The route's length, measured exactly the same way as buildTrack.
// (osrmSteps.ts uses this so step positions and GPS progress share one ruler.)
export function pathLengthMeters(coords: Coord[]): number {
  return buildTrack(coords).lengthMeters;
}

function bearingRad(a: Coord, b: Coord): number {
  const lat1 = a[1] * TO_RAD;
  const lat2 = b[1] * TO_RAD;
  const dLon = (b[0] - a[0]) * TO_RAD;
  return Math.atan2(
    Math.sin(dLon) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  );
}

// Spherical cross-track / along-track maths: where does point p fall on the
// great-circle segment a->b? (No flat-map shortcuts on latitude/longitude.)
function projectOnSegment(p: Coord, a: Coord, b: Coord, segmentLength: number) {
  const distA = metres(a, p);
  const distB = metres(b, p);
  const bearingAB = bearingRad(a, b);
  const bearingDeg = (bearingAB * TO_DEG + 360) % 360;

  // A tiny segment, or a point very far away: just use the nearer end
  if (segmentLength < 0.5 || distA > 50000) {
    return distA <= distB
      ? { distanceM: distA, alongM: 0, bearingDeg }
      : { distanceM: distB, alongM: segmentLength, bearingDeg };
  }

  const angularA = distA / EARTH_RADIUS_M;
  const offset = bearingRad(a, p) - bearingAB;
  // Right-angled spherical triangle: tan(along) = tan(distance to A) x cos(angle)
  const alongM = Math.atan(Math.tan(angularA) * Math.cos(offset)) * EARTH_RADIUS_M;

  if (alongM <= 0) return { distanceM: distA, alongM: 0, bearingDeg };
  if (alongM >= segmentLength) return { distanceM: distB, alongM: segmentLength, bearingDeg };

  const crossM = Math.abs(Math.asin(Math.sin(angularA) * Math.sin(offset))) * EARTH_RADIUS_M;
  return { distanceM: crossM, alongM, bearingDeg };
}

// The segment that contains a given distance along the route
function findSegment(track: RouteTrack, meters: number): number {
  const last = track.coords.length - 2;
  if (meters <= 0) return 0;
  let low = 0;
  let high = last;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const at = track.cumulative[mid];
    if (at !== undefined && at <= meters) low = mid;
    else high = mid - 1;
  }
  return low;
}

// The point a given distance along the route (used to print test coordinates)
export function pointAt(track: RouteTrack, meters: number): Coord | null {
  const index = findSegment(track, meters);
  const a = track.coords[index];
  const b = track.coords[index + 1];
  const start = track.cumulative[index];
  const end = track.cumulative[index + 1];
  if (!a || !b || start === undefined || end === undefined) return track.coords[0] ?? null;
  const length = end - start;
  const t = length > 0 ? Math.min(1, Math.max(0, (meters - start) / length)) : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function coordinatesThroughDistance(track: RouteTrack, meters: number): Coord[] {
  if (track.coords.length < 2 || !Number.isFinite(meters) || meters <= 0) return [];
  if (meters >= track.lengthMeters) return [...track.coords];

  const index = findSegment(track, meters);
  const partial = pointAt(track, meters);
  if (!partial) return [];
  const travelled = track.coords.slice(0, index + 1);
  const last = travelled[travelled.length - 1];
  if (!last || last[0] !== partial[0] || last[1] !== partial[1]) travelled.push(partial);
  return travelled.length > 1 ? travelled : [];
}

function scan(track: RouteTrack, p: Coord, first: number, last: number): RouteMatch | null {
  let best: RouteMatch | null = null;
  for (let i = first; i <= last; i++) {
    const a = track.coords[i];
    const b = track.coords[i + 1];
    const start = track.cumulative[i];
    const end = track.cumulative[i + 1];
    if (!a || !b || start === undefined || end === undefined) continue;

    const result = projectOnSegment(p, a, b, end - start);
    if (!best || result.distanceM < best.distanceM) {
      best = {
        progressMeters: start + result.alongM,
        distanceM: result.distanceM,
        segmentIndex: i,
        bearingDeg: result.bearingDeg,
      };
    }
  }
  return best;
}

// Finds the nearest point on the route for a GPS position.
// hintMeters = the last known progress. It makes the search local, so a route that
// passes the same spot twice can't suddenly jump to the wrong pass.
export function matchToRoute(
  track: RouteTrack,
  lat: number,
  lon: number,
  hintMeters: number | null
): RouteMatch | null {
  const lastSegment = track.coords.length - 2;
  if (lastSegment < 0) return null;
  const p: Coord = [lon, lat];

  if (hintMeters === null) return scan(track, p, 0, lastSegment);

  const near = scan(
    track,
    p,
    findSegment(track, hintMeters - WINDOW_BACK_M),
    findSegment(track, hintMeters + WINDOW_AHEAD_M)
  );
  if (near && near.distanceM <= WINDOW_ACCEPT_M) return near;

  // Nothing close nearby: look at the whole route, but only believe it if it is clearly better
  const all = scan(track, p, 0, lastSegment);
  if (near && all && all.distanceM > near.distanceM - 20) return near;
  return all ?? near;
}