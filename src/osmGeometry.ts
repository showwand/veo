import type { Coord, XY } from "./routeGeometry";

const METRES_PER_DEGREE = 111320;

// Turns [lon, lat] into flat metres. Same trick routeGeometry.ts uses.
// Everything we compare is projected with the SAME function, so small
// distortions cancel out.
export type Projector = (coord: Coord) => XY;

export function makeProjector(refLat: number): Projector {
  const cosLat = Math.cos((refLat * Math.PI) / 180);
  return ([lon, lat]) => ({
    x: lon * cosLat * METRES_PER_DEGREE,
    y: lat * METRES_PER_DEGREE,
  });
}

// Closest point on the segment a-b to point p.
// t is how far along a->b it is (0 = at a, 1 = at b).
export function nearestOnSegment(p: XY, a: XY, b: XY): { distance: number; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  let t = lengthSquared === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const nx = a.x + abx * t;
  const ny = a.y + aby * t;
  return { distance: Math.hypot(p.x - nx, p.y - ny), t };
}

// A point on the route, with how far along it is and which way the route is heading
export type Sample = {
  x: number;
  y: number;
  distance: number; // metres from the start of the route
  dx: number; // heading as a unit vector
  dy: number;
};

// Places a sample every `spacing` metres along a path
export function sampleAlong(
  path: XY[],
  spacing: number
): { samples: Sample[]; length: number } {
  const samples: Sample[] = [];
  let walked = 0;
  let nextAt = 0;

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) continue;

    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (segment === 0) continue;
    const dx = (b.x - a.x) / segment;
    const dy = (b.y - a.y) / segment;

    while (nextAt <= walked + segment) {
      const along = nextAt - walked;
      samples.push({ x: a.x + dx * along, y: a.y + dy * along, distance: nextAt, dx, dy });
      nextAt += spacing;
    }
    walked += segment;
  }

  return { samples, length: walked };
}

// Douglas-Peucker line simplifying: returns the indices of the points to keep,
// so the simplified line never strays further than `tolerance` metres from the
// original. (Written with a stack instead of recursion so very long routes are safe.)
export function simplifyIndices(path: XY[], tolerance: number): number[] {
  const count = path.length;
  if (count <= 2) return path.map((_, index) => index);

  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;

  const stack: [number, number][] = [[0, count - 1]];
  for (;;) {
    const range = stack.pop();
    if (!range) break;
    const [first, last] = range;
    const a = path[first];
    const b = path[last];
    if (!a || !b) continue;

    let farthest = -1;
    let farthestDistance = -1;
    for (let i = first + 1; i < last; i++) {
      const p = path[i];
      if (!p) continue;
      const { distance } = nearestOnSegment(p, a, b);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = i;
      }
    }

    if (farthest !== -1 && farthestDistance > tolerance) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  const indices: number[] = [];
  keep.forEach((flag, index) => {
    if (flag) indices.push(index);
  });
  return indices;
}