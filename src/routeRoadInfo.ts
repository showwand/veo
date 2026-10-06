import type { Route } from "./routing";
import type { Coord, XY } from "./routeGeometry";
import { fetchRoadsAlongCorridor, type OsmNode, type OsmWay } from "./osm";
import { camerasInBounds, loadCameraDataset } from "./cameraDataset";
import { cameraRejectionReason, parseCamera, type RouteCamera } from "./osmCameras";
import {
  makeProjector,
  nearestOnSegment,
  sampleAlong,
  simplifyIndices,
  type Projector,
  type Sample,
} from "./osmGeometry";
import {
  cleanTag,
  parseFlag,
  parseLanes,
  parseMaxspeed,
  parseOneway,
  type SpeedLimit,
} from "./osmTags";
import {
  buildSpeedLimitSections,
  buildSpeedLimitSigns,
  type SpeedLimitSection,
  type SpeedLimitSign,
} from "./speedLimitSections";

// ---------- Settings you can tweak later ----------

// A camera is shown only if it is within this many metres of the route line
export const CAMERA_CORRIDOR_M = 50;
// Cameras are first filtered to the route's bounding box plus this margin.
// (Only a speed-up, and it lets the log list near misses.)
const CAMERA_CANDIDATE_PAD_M = 150;
// The log lists cameras that were rejected but within this distance of the route
const NEAR_MISS_LOG_M = 150;
// A road counts as "the road the route uses" if it is this close to the route
const ROAD_MATCH_M = 25;
// ...and runs roughly the same way (within this angle). Stops a crossing road
// from being matched at a junction.
const MAX_ANGLE_DEGREES = 35;
// Points are checked along the route this often
const SAMPLE_SPACING_M = 15;
// If the road we were just on is almost as good as the best match, stay on it
// (stops flicker between two roads at junctions and dual carriageways)
const STICKY_BONUS_M = 6;
// Unmatched points tolerated inside one road section before it is split
const MAX_GAP_SAMPLES = 3;
// The line sent to Overpass for ROADS is simplified; this is the starting tolerance
const SIMPLIFY_START_M = 15;
const MAX_SIMPLIFY_M = 240;
// Must stay below what MAX_QUERIES x POINTS_PER_QUERY in osm.ts can carry
// (4 queries of 400 points that share one point each = 1597 points at most).
const MAX_QUERY_POINTS = 1500;
const GRID_CELL_M = 50;
const CACHE_LIMIT = 20;

// ---------- Types ----------

// One stretch of the route that runs along one OSM road
export type RouteRoad = {
  osmId: number;
  name: string | null;
  ref: string | null;
  highway: string;
  maxspeed: SpeedLimit | null; // null = OSM doesn't say
  lanes: number | null;
  oneway: boolean | null;
  surface: string | null;
  bridge: boolean;
  tunnel: boolean;
  junction: string | null;
  geometry: Coord[]; // the OSM road's own line, [lon, lat]
  startMeters: number; // where this stretch begins, measured along the route
  endMeters: number;
  lengthMeters: number;
};

export type RouteOsmInfo = {
  roads: RouteRoad[]; // in driving order (from Overpass)
  cameras: RouteCamera[]; // in driving order, deduplicated (from the static dataset)
  // Speed limits of the route, derived from `roads`: continuous sections, merged
  speedSections: SpeedLimitSection[];
  // The signs to draw: the start of each new known mph section
  speedSigns: SpeedLimitSign[];
  routeLengthMeters: number;
  // How much of the route we could match to an OSM road. The rest is "unknown".
  matchedMeters: number;
};

// ---------- Matching roads to the route ----------

type Segment = {
  a: XY;
  b: XY;
  dx: number; // unit direction
  dy: number;
  wayIndex: number;
};

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

// Puts every road segment into a coarse grid, so each route point only has to
// look at nearby segments instead of every road.
function buildGrid(ways: OsmWay[], project: Projector): Map<string, Segment[]> {
  const grid = new Map<string, Segment[]>();

  ways.forEach((way, wayIndex) => {
    const points = way.geometry.map(project);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (!a || !b) continue;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length === 0) continue;

      const segment: Segment = {
        a,
        b,
        dx: (b.x - a.x) / length,
        dy: (b.y - a.y) / length,
        wayIndex,
      };

      const minX = Math.floor(Math.min(a.x, b.x) / GRID_CELL_M);
      const maxX = Math.floor(Math.max(a.x, b.x) / GRID_CELL_M);
      const minY = Math.floor(Math.min(a.y, b.y) / GRID_CELL_M);
      const maxY = Math.floor(Math.max(a.y, b.y) / GRID_CELL_M);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
          const key = cellKey(cx, cy);
          const list = grid.get(key);
          if (list) list.push(segment);
          else grid.set(key, [segment]);
        }
      }
    }
  });

  return grid;
}

// For one point on the route, finds the OSM road it is driving on (or -1)
function matchSample(
  sample: Sample,
  grid: Map<string, Segment[]>,
  previousWay: number
): number {
  const cx = Math.floor(sample.x / GRID_CELL_M);
  const cy = Math.floor(sample.y / GRID_CELL_M);

  let bestWay = -1;
  let bestScore = Infinity;
  let previousScore = Infinity;

  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const segments = grid.get(cellKey(cx + ox, cy + oy));
      if (!segments) continue;

      for (const segment of segments) {
        const { distance } = nearestOnSegment(sample, segment.a, segment.b);
        if (distance > ROAD_MATCH_M) continue;

        // 0 degrees = same line (either direction), 90 = crossing road
        const parallel = Math.abs(sample.dx * segment.dx + sample.dy * segment.dy);
        const angle = (Math.acos(Math.min(1, parallel)) * 180) / Math.PI;
        if (angle > MAX_ANGLE_DEGREES) continue;

        // Lower is better: close AND heading the same way
        const score = distance + (angle / MAX_ANGLE_DEGREES) * 15;
        if (score < bestScore) {
          bestScore = score;
          bestWay = segment.wayIndex;
        }
        if (segment.wayIndex === previousWay && score < previousScore) {
          previousScore = score;
        }
      }
    }
  }

  if (previousWay !== -1 && previousScore <= bestScore + STICKY_BONUS_M) return previousWay;
  return bestWay;
}

function matchRoads(
  ways: OsmWay[],
  samples: Sample[],
  routeLength: number,
  project: Projector
): { roads: RouteRoad[]; matchedMeters: number } {
  const grid = buildGrid(ways, project);

  type Section = { wayIndex: number; first: number; last: number };
  const sections: Section[] = [];
  let current: Section | null = null;
  let previousWay = -1;
  let gap = 0;

  for (const sample of samples) {
    const wayIndex = matchSample(sample, grid, previousWay);

    if (wayIndex === -1) {
      gap++;
      if (gap > MAX_GAP_SAMPLES) {
        current = null;
        previousWay = -1;
      }
      continue;
    }

    gap = 0;
    previousWay = wayIndex;
    if (current && current.wayIndex === wayIndex) {
      current.last = sample.distance;
    } else {
      current = { wayIndex, first: sample.distance, last: sample.distance };
      sections.push(current);
    }
  }

  const half = SAMPLE_SPACING_M / 2;
  let matchedMeters = 0;
  const roads: RouteRoad[] = [];

  for (const section of sections) {
    const way = ways[section.wayIndex];
    if (!way) continue;

    const startMeters = Math.max(0, section.first - half);
    const endMeters = Math.min(routeLength, section.last + half);
    const { tags } = way;
    matchedMeters += endMeters - startMeters;

    roads.push({
      osmId: way.id,
      name: cleanTag(tags.name),
      ref: cleanTag(tags.ref),
      highway: tags.highway ?? "unknown",
      maxspeed: parseMaxspeed(tags.maxspeed),
      lanes: parseLanes(tags.lanes),
      oneway: parseOneway(tags.oneway),
      surface: cleanTag(tags.surface),
      bridge: parseFlag(tags.bridge),
      tunnel: parseFlag(tags.tunnel),
      junction: cleanTag(tags.junction),
      geometry: way.geometry,
      startMeters,
      endMeters,
      lengthMeters: endMeters - startMeters,
    });
  }

  return { roads, matchedMeters };
}

// ---------- Matching cameras to the route ----------

// The route as flat points, plus how far along the route each point is
type RoutePath = { path: XY[]; cumulative: number[] };

function buildCumulative(path: XY[]): number[] {
  const cumulative: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const before = cumulative[i - 1] ?? 0;
    cumulative.push(a && b ? before + Math.hypot(b.x - a.x, b.y - a.y) : before);
  }
  return cumulative;
}

// How far (metres) a point is from the route line, and how far along the route that is
function nearestOnRoute(p: XY, route: RoutePath): { distance: number; along: number } {
  let nearest = Infinity;
  let along = 0;
  for (let i = 1; i < route.path.length; i++) {
    const a = route.path[i - 1];
    const b = route.path[i];
    const start = route.cumulative[i - 1];
    if (!a || !b || start === undefined) continue;

    const result = nearestOnSegment(p, a, b);
    if (result.distance < nearest) {
      nearest = result.distance;
      along = start + result.t * Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return { distance: nearest, along };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// What happened to every camera that reached route matching (for the console log)
type OutsideRow = { osmId: number; kind: string; lat: number; lon: number; nearestRouteM: number };
type RejectedRow = { osmId: number; reason: string; lat: number; lon: number; nearestRouteM: number };

type CameraStats = {
  queried: number; // cameras that reached matching (the dataset's cameras near the route)
  parsed: number; // accepted as camera objects by osmCameras.ts
  rejected: number; // refused by osmCameras.ts
  rejectedReasons: Record<string, number>;
  rejectedRows: RejectedRow[];
  duplicates: number; // dropped as repeats
  beforeMatch: number; // parsed minus duplicates: what went into route matching
  matched: number; // within CAMERA_CORRIDOR_M of the route
  displayed: number; // what is handed to the map layer
  speedKind: number;
  otherKind: number;
  outside: OutsideRow[]; // near the route's bounding box, but further than CAMERA_CORRIDOR_M
};

function matchCameras(
  nodes: OsmNode[],
  route: RoutePath,
  project: Projector
): { cameras: RouteCamera[]; stats: CameraStats } {
  const seenIds = new Set<number>();
  const seenSpots = new Set<string>();
  const cameras: RouteCamera[] = [];
  const outside: OutsideRow[] = [];
  const rejectedRows: RejectedRow[] = [];
  const rejectedReasons: Record<string, number> = {};
  let parsed = 0;
  let duplicates = 0;

  for (const node of nodes) {
    const p = project([node.lon, node.lat]);
    const camera = parseCamera(node);

    if (!camera) {
      const reason = cameraRejectionReason(node) ?? "unknown";
      rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1;
      rejectedRows.push({
        osmId: node.id,
        reason,
        lat: node.lat,
        lon: node.lon,
        nearestRouteM: round1(nearestOnRoute(p, route).distance),
      });
      continue;
    }
    parsed++;

    if (seenIds.has(camera.osmId)) {
      duplicates++; // same OSM node twice
      continue;
    }

    // Two nodes stacked on the exact same spot and kind would draw one icon on top of the other
    const spot = `${camera.kind}:${camera.lat.toFixed(5)},${camera.lon.toFixed(5)}`;
    if (seenSpots.has(spot)) {
      duplicates++;
      continue;
    }

    const { distance, along } = nearestOnRoute(p, route);

    if (distance > CAMERA_CORRIDOR_M) {
      outside.push({
        osmId: camera.osmId,
        kind: camera.kind,
        lat: camera.lat,
        lon: camera.lon,
        nearestRouteM: round1(distance),
      });
      continue; // outside the corridor: not on this route
    }

    seenIds.add(camera.osmId);
    seenSpots.add(spot);
    cameras.push({ ...camera, distanceAlongRoute: along, distanceFromRoute: distance });
  }

  cameras.sort((a, b) => a.distanceAlongRoute - b.distanceAlongRoute);
  outside.sort((a, b) => a.nearestRouteM - b.nearestRouteM);

  const stats: CameraStats = {
    queried: nodes.length,
    parsed,
    rejected: rejectedRows.length,
    rejectedReasons,
    rejectedRows,
    duplicates,
    beforeMatch: parsed - duplicates,
    matched: cameras.length,
    displayed: cameras.length,
    speedKind: cameras.filter((c) => c.kind === "speed").length,
    otherKind: cameras.filter((c) => c.kind === "other").length,
    outside,
  };
  return { cameras, stats };
}

// ---------- Console logging ----------

type DatasetDetails = { generatedAt: string; total: number };

function logCameraDiagnostics(route: Route, stats: CameraStats, dataset: DatasetDetails) {
  console.log(
    `Veode cameras: queried=${stats.queried} parsed=${stats.parsed} rejected=${stats.rejected} ` +
      `beforeMatch=${stats.beforeMatch} matched=${stats.matched} displayed=${stats.displayed}`
  );

  console.log("Veode cameras: details", {
    route: route.name,
    source: "static dataset",
    datasetCameras: dataset.total,
    datasetSnapshot: dataset.generatedAt,
    corridorM: CAMERA_CORRIDOR_M,
    duplicatesDropped: stats.duplicates,
    matchedSpeedKind: stats.speedKind,
    matchedOtherKind: stats.otherKind,
  });

  if (stats.rejected > 0) {
    console.log("Veode cameras: rejected by osmCameras.ts", stats.rejectedReasons);
    console.table(stats.rejectedRows);
  }

  const near = stats.outside.filter((c) => c.nearestRouteM <= NEAR_MISS_LOG_M);
  if (near.length > 0) {
    const within = (m: number) => near.filter((c) => c.nearestRouteM <= m).length;
    console.log(
      `Veode cameras: ${near.length} just outside the ${CAMERA_CORRIDOR_M} m corridor ` +
        `(within 75 m: ${within(75)}, 100 m: ${within(100)}, 150 m: ${within(150)})`
    );
    console.table(near);
  }
}

// ---------- Cache ----------

const cache = new Map<string, RouteOsmInfo>();

// Identifies a route by its shape (a few points along it), not by its object identity
function cacheKey(route: Route): string {
  const coords = route.geometry.coordinates;
  const last = coords.length - 1;
  const picks = [0, 0.25, 0.5, 0.75, 1].map((f) => coords[Math.round(last * f)]);
  const parts = picks.map((c) => (c ? `${c[0].toFixed(5)},${c[1].toFixed(5)}` : "-"));
  const distanceKey =
    route.distanceMeters === null ? "unknown-distance" : String(Math.round(route.distanceMeters));
  return `${coords.length}|${distanceKey}|${parts.join("|")}`;
}

export function getCachedRouteOsmInfo(route: Route): RouteOsmInfo | null {
  return cache.get(cacheKey(route)) ?? null;
}

function remember(route: Route, info: RouteOsmInfo) {
  cache.set(cacheKey(route), info);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// ---------- Simplifying the line sent to Overpass (roads only) ----------

// A motorway doesn't need thousands of points. The simplified line can stray up to
// `tolerance` metres from the real one, so the search radius is widened by that.
function simplifyForQuery(
  coords: Coord[],
  path: XY[]
): { line: Coord[]; tolerance: number } {
  for (let tolerance = SIMPLIFY_START_M; tolerance <= MAX_SIMPLIFY_M; tolerance *= 2) {
    const indices = simplifyIndices(path, tolerance);
    if (indices.length <= MAX_QUERY_POINTS) {
      const line: Coord[] = [];
      for (const index of indices) {
        const coord = coords[index];
        if (coord) line.push(coord);
      }
      return { line, tolerance };
    }
  }
  throw new Error("Route is too long for an OpenStreetMap lookup");
}

// ---------- The one function the app calls ----------

// Step A: cameras from the static dataset (no network except the one-time file load).
//         They are reported through onCameras straight away.
// Step B: roads from Overpass, then the speed-limit sections and signs derived from them.
//         If this fails, the cameras are still kept.
// Only a fully successful lookup is cached, so a failed part is retried next time.
export async function loadRouteOsmInfo(
  route: Route,
  signal: AbortSignal,
  onCameras?: (partial: RouteOsmInfo) => void
): Promise<RouteOsmInfo> {
  const cached = getCachedRouteOsmInfo(route);
  if (cached) return cached;

  const coords = route.geometry.coordinates;
  const [, south, , north] = route.bounds;
  const project = makeProjector((south + north) / 2);
  const path = coords.map(project);
  const routePath: RoutePath = { path, cumulative: buildCumulative(path) };
  const { samples, length } = sampleAlong(path, SAMPLE_SPACING_M);

  // ----- Step A: cameras from the static dataset -----
  let cameras: RouteCamera[] = [];
  let camerasOk = false;
  try {
    const dataset = await loadCameraDataset();
    signal.throwIfAborted();

    const candidates = camerasInBounds(dataset.nodes, route.bounds, CAMERA_CANDIDATE_PAD_M);
    const matched = matchCameras(candidates, routePath, project);
    cameras = matched.cameras;
    camerasOk = true;

    logCameraDiagnostics(route, matched.stats, {
      generatedAt: dataset.generatedAt,
      total: dataset.nodes.length,
    });
  } catch (error) {
    if (signal.aborted) throw error; // cancelled on purpose
    console.warn("Veode cameras: static dataset unavailable", error);
  }

  // Cameras can be drawn now, without waiting for the road query
  onCameras?.({
    roads: [],
    cameras,
    speedSections: [],
    speedSigns: [],
    routeLengthMeters: length,
    matchedMeters: 0,
  });

  // ----- Step B: roads (optional: a failure here must not remove the cameras) -----
  let roads: RouteRoad[] = [];
  let matchedMeters = 0;
  let speedSections: SpeedLimitSection[] = [];
  let speedSigns: SpeedLimitSign[] = [];
  let roadsOk = false;
  try {
    const { line, tolerance } = simplifyForQuery(coords, path);
    const roadData = await fetchRoadsAlongCorridor(line, ROAD_MATCH_M + tolerance, signal);
    signal.throwIfAborted();

    const matched = matchRoads(roadData.ways, samples, length, project);
    roads = matched.roads;
    matchedMeters = matched.matchedMeters;

    // Speed limits come from the road sections above, not from a second map query
    speedSections = buildSpeedLimitSections(roads);
    speedSigns = buildSpeedLimitSigns(speedSections, coords, routePath.cumulative);
    roadsOk = true;

    const byStatus: Record<string, number> = {};
    for (const section of speedSections) {
      byStatus[section.status] = (byStatus[section.status] ?? 0) + 1;
    }
    console.log("Veode roads:", {
      waysReturned: roadData.ways.length,
      roadSections: roads.length,
      roadQuery: roadData.diagnostics,
    });
    console.log("Veode speed limits:", {
      sections: speedSections.length,
      signs: speedSigns.length,
      sectionsByStatus: byStatus,
    });
  } catch (error) {
    if (signal.aborted) throw error; // cancelled on purpose
    console.warn("Veode OSM: road lookup failed, keeping cameras only", error);
  }

  const info: RouteOsmInfo = {
    roads,
    cameras,
    speedSections,
    speedSigns,
    routeLengthMeters: length,
    matchedMeters,
  };
  if (roadsOk && camerasOk) remember(route, info);
  return info;
}

// ---------- Small questions the navigation phase will ask ----------

// "What road am I on, this far along the route?"
export function roadAtDistance(info: RouteOsmInfo, meters: number): RouteRoad | null {
  return info.roads.find((r) => meters >= r.startMeters && meters <= r.endMeters) ?? null;
}

// "What speed limit applies this far along the route?" Null when OSM doesn't say,
// or says something we can't state as a single mph number.
export function speedLimitAtDistance(info: RouteOsmInfo, meters: number): number | null {
  const section = info.speedSections.find(
    (s) => meters >= s.startMeters && meters <= s.endMeters
  );
  return section?.status === "known" ? section.mph : null;
}

// Share (0 to 1) of the MATCHED route that is motorway. Null if nothing was matched.
// (For the future "Avoid Motorways" scoring.)
export function motorwayShare(info: RouteOsmInfo): number | null {
  if (info.matchedMeters <= 0) return null;
  const motorway = info.roads
    .filter((r) => r.highway === "motorway" || r.highway === "motorway_link")
    .reduce((sum, r) => sum + r.lengthMeters, 0);
  return motorway / info.matchedMeters;
}