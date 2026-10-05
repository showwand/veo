import type { Point } from "./routing";

// A point as OSRM gives it: [longitude, latitude]
export type Coord = [number, number];

// A point measured in metres on a flat map (x = east, y = north).
// Comparing routes is far easier in metres than in degrees.
export type XY = { x: number; y: number };

const EARTH_RADIUS_M = 6371000;
const METRES_PER_DEGREE = 111320;

// ---------- Settings you can tweak later ----------

// Routes are compared by checking points placed every 100 m along them
const SAMPLE_SPACING_M = 100;
// ...and a point counts as "on the same road" if it is in the same or a
// neighbouring 150 m square of the map (so roughly within 150-300 m)
const CELL_M = 150;
// The first and last stretch of every route is ignored when comparing, because
// all routes leave from the same place and arrive at the same place.
// (15% of the route, but never more than 600 m)
const END_TRIM_FRACTION = 0.15;
const END_TRIM_MAX_M = 600;
// A route "doubles back" if it returns to a spot it passed more than this many
// samples (8 x 100 m = 800 m) earlier
const BACKTRACK_GAP_SAMPLES = 8;

// A route prepared for comparing. Built once, then reused for every comparison.
export type PreparedRoute = {
  refLat: number; // the latitude used to flatten the map (same for all routes)
  path: XY[]; // the route's own points, in metres
  lengthMeters: number;
  samples: XY[]; // points every 100 m along the route
  middle: XY[]; // the samples without the start and end stretches
  cells: Set<string>; // the map squares the route passes through
};

// ---------- Small helpers ----------

// Straight-line distance in metres between two points on the Earth
export function distanceBetween(a: Point, b: Point): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Works out the box around a route by checking every point
export function getBounds(
  coordinates: Coord[]
): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of coordinates) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

function toXY([lon, lat]: Coord, refLat: number): XY {
  const cosLat = Math.cos((refLat * Math.PI) / 180);
  return { x: lon * cosLat * METRES_PER_DEGREE, y: lat * METRES_PER_DEGREE };
}

function toPoint(p: XY, refLat: number): Point {
  const cosLat = Math.cos((refLat * Math.PI) / 180);
  return { lon: p.x / (cosLat * METRES_PER_DEGREE), lat: p.y / METRES_PER_DEGREE };
}

function pathLength(path: XY[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

function cellKey(p: XY): string {
  return `${Math.floor(p.x / CELL_M)},${Math.floor(p.y / CELL_M)}`;
}

// Places a point every `spacing` metres along a path (plus the very start and end)
function resample(path: XY[], spacing: number): XY[] {
  const first = path[0];
  if (!first) return [];

  const out: XY[] = [first];
  let remaining = spacing; // distance still to travel before the next sample

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) continue;

    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (segment === 0) continue;

    let offset = 0;
    while (segment - offset >= remaining) {
      offset += remaining;
      const f = offset / segment;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      remaining = spacing;
    }
    remaining -= segment - offset;
  }

  const last = path[path.length - 1];
  if (last && out.length > 1) out.push(last);
  return out;
}

// The spot a given distance (in metres) along a path
function positionAt(path: XY[], distance: number): XY {
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) continue;

    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 0 && walked + length >= distance) {
      const f = (distance - walked) / length;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    walked += length;
  }
  return path[path.length - 1] ?? { x: 0, y: 0 };
}

// ---------- Preparing and comparing routes ----------

export function prepareRoute(coords: Coord[], refLat: number): PreparedRoute {
  const path = coords.map((coord) => toXY(coord, refLat));
  const lengthMeters = pathLength(path);
  const samples = resample(path, SAMPLE_SPACING_M);

  const trim = Math.min(END_TRIM_MAX_M, lengthMeters * END_TRIM_FRACTION);
  const middle = samples.filter((_, index) => {
    const distance = index * SAMPLE_SPACING_M;
    return distance >= trim && distance <= lengthMeters - trim;
  });

  return {
    refLat,
    path,
    lengthMeters,
    samples,
    // A very short route may have nothing left after trimming, so fall back to all of it
    middle: middle.length > 0 ? middle : samples,
    cells: new Set(samples.map(cellKey)),
  };
}

// What share (0 to 1) of these points lie on a road the other route also uses?
function shareNear(points: XY[], otherCells: Set<string>): number {
  if (points.length === 0) return 0;

  let near = 0;
  for (const p of points) {
    const cx = Math.floor(p.x / CELL_M);
    const cy = Math.floor(p.y / CELL_M);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        if (otherCells.has(`${cx + dx},${cy + dy}`)) found = true;
      }
    }
    if (found) near++;
  }
  return near / points.length;
}

// How alike two routes are, from 0 (completely different roads) to 1 (the same road).
// It checks the middle of each route against the other, then averages both ways.
export function routeSimilarity(a: PreparedRoute, b: PreparedRoute): number {
  return (shareNear(a.middle, b.cells) + shareNear(b.middle, a.cells)) / 2;
}

// What share (0 to 1) of a route drives back over road it already used earlier?
// A big number means the route runs out to a spot and returns the same way
// (a "spike"), which is what a forced waypoint can accidentally create.
export function retraceShare(route: PreparedRoute): number {
  if (route.samples.length === 0) return 0;

  const firstVisit = new Map<string, number>();
  let retraced = 0;
  route.samples.forEach((sample, index) => {
    const key = cellKey(sample);
    const first = firstVisit.get(key);
    if (first === undefined) {
      firstVisit.set(key, index);
    } else if (index - first > BACKTRACK_GAP_SAMPLES) {
      retraced++;
    }
  });
  return retraced / route.samples.length;
}

// ---------- Choosing waypoints ----------

// Picks a spot beside a route: go `fraction` of the way along it (0 = start,
// 1 = end), then step sideways by `offsetMeters`. side = 1 is to the left of the
// direction of travel, side = -1 is to the right.
// Routing THROUGH that spot forces the router onto a different corridor.
export function sidePoint(
  route: PreparedRoute,
  fraction: number,
  side: 1 | -1,
  offsetMeters: number
): Point | null {
  const total = route.lengthMeters;
  if (total <= 0) return null;

  const at = total * fraction;
  // Work out which way the road is heading by looking a little ahead and behind
  const window = Math.min(total * 0.05, 2000);
  const here = positionAt(route.path, at);
  const behind = positionAt(route.path, Math.max(0, at - window));
  const ahead = positionAt(route.path, Math.min(total, at + window));

  const headingX = ahead.x - behind.x;
  const headingY = ahead.y - behind.y;
  const length = Math.hypot(headingX, headingY);
  if (length === 0) return null;

  // Turning the heading 90 degrees anticlockwise points to the left
  return toPoint(
    {
      x: here.x + (-headingY / length) * offsetMeters * side,
      y: here.y + (headingX / length) * offsetMeters * side,
    },
    route.refLat
  );
}