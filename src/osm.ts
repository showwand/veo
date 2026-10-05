import type { Coord } from "./routeGeometry";

// ---------- Settings you can tweak later ----------

// Public Overpass servers, tried in order. If one is busy or down, we try the
// next. A server that works is moved to the front for later requests.
// These are free community services: be gentle with them.
// (Cameras no longer use Overpass: they come from public/cameras-uk.json.)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// How long one server gets to answer before we give up and try the next
const ROAD_TIMEOUT_MS = 30000;

// A long route is split into several smaller queries of this many points
const POINTS_PER_QUERY = 400;
// ...and we refuse routes that would need more than this many queries
const MAX_QUERIES = 4;

// The road classes we ask for
export const ROAD_CLASSES = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "track",
] as const;

// ---------- Types ----------

export type OsmTags = Record<string, string>;

export type OsmWay = {
  id: number;
  tags: OsmTags;
  geometry: Coord[]; // [lon, lat] pairs
};

// A point with tags. Cameras from the static dataset use this shape too.
export type OsmNode = {
  id: number;
  lat: number;
  lon: number;
  tags: OsmTags;
};

// Facts about how an Overpass request went (for the console log)
export type OsmDiagnostics = {
  chunks: number;
  rawElements: number; // everything Overpass sent back, before removing duplicates
  endpoints: string[]; // which server answered each chunk
  failures: string[]; // servers that failed before another one worked
  elapsedMs: number;
};

export type OsmRoadData = { ways: OsmWay[]; diagnostics: OsmDiagnostics };

// The parts of an Overpass element that we use
type RawElement = {
  type: string;
  id: number;
  tags?: OsmTags;
  geometry?: { lat: number; lon: number }[];
};

// ---------- Query ----------

function toPolyline(line: Coord[]): string {
  return line.map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(",");
}

// ROADS: highways near the line.
// "around" with several points means "within R metres of this polyline".
function buildRoadQuery(line: Coord[], radius: number): string {
  const classes = ROAD_CLASSES.join("|");
  return [
    "[out:json][timeout:25];",
    `way["highway"~"^(${classes})$"](around:${Math.ceil(radius)},${toPolyline(line)});`,
    "out tags geom;",
  ].join("\n");
}

// ---------- Talking to Overpass ----------

// The servers in the order we try them. A server that works moves to the front.
const endpointOrder: string[] = [...OVERPASS_ENDPOINTS];

function promote(endpoint: string) {
  const index = endpointOrder.indexOf(endpoint);
  if (index > 0) {
    endpointOrder.splice(index, 1);
    endpointOrder.unshift(endpoint);
  }
}

// Sends one query to one server. Gives up after timeoutMs.
// `signal` is the caller's "cancel" signal (the user picked another route).
async function postQuery(
  endpoint: string,
  query: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<RawElement[]> {
  signal.throwIfAborted();

  // Our own controller: it aborts when the caller cancels OR when the time runs out
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel);
  const timer = setTimeout(cancel, timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Overpass responded ${response.status}`);

    const data = (await response.json()) as { elements?: RawElement[]; remark?: string };
    // Overpass can answer 200 OK but include a "remark" saying it ran out of time or memory
    if (data.remark) {
      console.warn("Veode OSM: Overpass remark:", data.remark);
      if (/error|timed out|out of memory/i.test(data.remark)) {
        throw new Error(`Overpass remark: ${data.remark}`);
      }
    }
    return data.elements ?? [];
  } catch (error) {
    // Aborted by OUR timer (not by the caller): report it as a timeout
    if (!signal.aborted && controller.signal.aborted) {
      throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`, { cause: error });
    }
    throw new Error("Overpass request failed", { cause: error });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

// Tries each server in turn until one answers
async function queryOverpass(
  query: string,
  signal: AbortSignal,
  failures: string[],
  timeoutMs: number
): Promise<{ elements: RawElement[]; endpoint: string }> {
  let lastError: unknown = new Error("No Overpass endpoint configured");

  for (const endpoint of [...endpointOrder]) {
    try {
      const elements = await postQuery(endpoint, query, signal, timeoutMs);
      promote(endpoint);
      return { elements, endpoint };
    } catch (error) {
      if (signal.aborted) throw error; // cancelled on purpose: stop, don't try the next server
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${endpoint}: ${message}`);
      console.warn(`Veode OSM: ${endpoint} failed (${message})`);
      lastError = error;
    }
  }

  console.warn("Veode OSM: every Overpass endpoint failed", failures);
  throw lastError;
}

// Splits a long line into overlapping chunks (they share one point, so there are no gaps)
function splitIntoChunks(line: Coord[]): Coord[][] {
  const chunks: Coord[][] = [];
  for (let i = 0; i < line.length - 1; i += POINTS_PER_QUERY - 1) {
    chunks.push(line.slice(i, i + POINTS_PER_QUERY));
  }
  if (chunks.length > MAX_QUERIES) {
    throw new Error("Route is too long for an OpenStreetMap lookup");
  }
  return chunks;
}

// ---------- The function the app uses ----------

// Roads within radiusM of the (simplified) route line.
export async function fetchRoadsAlongCorridor(
  line: Coord[],
  radiusM: number,
  signal: AbortSignal
): Promise<OsmRoadData> {
  const chunks = splitIntoChunks(line);
  const started = performance.now();
  const failures: string[] = [];
  const endpoints: string[] = [];
  const elements: RawElement[] = [];

  // One query per chunk, one after another
  for (const chunk of chunks) {
    const result = await queryOverpass(
      buildRoadQuery(chunk, radiusM),
      signal,
      failures,
      ROAD_TIMEOUT_MS
    );
    endpoints.push(result.endpoint);
    for (const element of result.elements) elements.push(element);
  }

  const ways = new Map<number, OsmWay>();
  for (const element of elements) {
    if (element.type === "way" && element.geometry && element.geometry.length >= 2) {
      ways.set(element.id, {
        id: element.id,
        tags: element.tags ?? {},
        geometry: element.geometry.map((p): Coord => [p.lon, p.lat]),
      });
    }
  }

  return {
    ways: [...ways.values()],
    diagnostics: {
      chunks: chunks.length,
      rawElements: elements.length,
      endpoints,
      failures,
      elapsedMs: Math.round(performance.now() - started),
    },
  };
}