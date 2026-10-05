import type { OsmNode, OsmTags } from "./osm";

// The snapshot written by scripts/update-cameras.mjs. It lives in public/,
// so the browser can fetch it directly.
const CAMERA_DATASET_URL = "/cameras-uk.json";

export type CameraDataset = {
  generatedAt: string; // when the snapshot was downloaded
  nodes: OsmNode[]; // in the same shape the Overpass code used, so parseCamera() works unchanged
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTags(value: unknown): OsmTags {
  const tags: OsmTags = {};
  if (isRecord(value)) {
    for (const [key, tag] of Object.entries(value)) {
      if (typeof tag === "string") tags[key] = tag;
    }
  }
  return tags;
}

// Checks the file really has the shape we expect. Anything odd is skipped, not guessed.
function readDataset(json: unknown): CameraDataset | null {
  if (!isRecord(json) || !Array.isArray(json.cameras)) return null;

  const items: unknown[] = json.cameras;
  const nodes: OsmNode[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const { id, lat, lon } = item;
    if (typeof id !== "number" || typeof lat !== "number" || typeof lon !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    nodes.push({ id, lat, lon, tags: readTags(item.tags) });
  }

  const generatedAt = typeof json.generatedAt === "string" ? json.generatedAt : "unknown";
  return { generatedAt, nodes };
}

async function fetchDataset(): Promise<CameraDataset> {
  const response = await fetch(CAMERA_DATASET_URL);
  if (!response.ok) throw new Error(`${CAMERA_DATASET_URL} responded ${response.status}`);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    // When a file is missing, the Vite dev server answers with the web page instead
    throw new Error(
      `${CAMERA_DATASET_URL} is missing or is not JSON. Run: node scripts/update-cameras.mjs`
    );
  }

  const dataset = readDataset(json);
  if (!dataset) throw new Error(`${CAMERA_DATASET_URL} is not in the expected format`);

  console.log(
    `Veode cameras: loaded static dataset, ${dataset.nodes.length} cameras (snapshot ${dataset.generatedAt})`
  );
  return dataset;
}

// Loaded ONCE and shared. If loading fails it is forgotten, so the next route tries again.
let loading: Promise<CameraDataset> | null = null;

export function loadCameraDataset(): Promise<CameraDataset> {
  if (!loading) {
    loading = fetchDataset().catch((error: unknown) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

// A quick first filter: only cameras inside the route's bounding box (plus a margin).
// The accurate "how far from the route line" check happens later, in routeRoadInfo.ts.
export function camerasInBounds(
  nodes: OsmNode[],
  bounds: [number, number, number, number],
  padMeters: number
): OsmNode[] {
  const [west, south, east, north] = bounds;
  const padLat = padMeters / 111320;
  const midLat = (south + north) / 2;
  const padLon = padMeters / (111320 * Math.cos((midLat * Math.PI) / 180));

  return nodes.filter(
    (node) =>
      node.lon >= west - padLon &&
      node.lon <= east + padLon &&
      node.lat >= south - padLat &&
      node.lat <= north + padLat
  );
}