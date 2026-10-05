import type { Coord } from "./routeGeometry";
import type { SpeedLimit, SpeedUnit } from "./osmTags";

// ---------- Settings you can tweak later ----------

// Two road sections with the SAME limit are merged into one if the gap between
// them is no bigger than this (tiny gaps are just matching noise).
const MERGE_GAP_M = 50;
// A section shorter than this never gets a sign (junction links and mapping blips)
const MIN_SIGN_SECTION_M = 40;
// If the same limit comes back after a stretch with no usable limit that is at
// least this long, show the sign again (we don't know what applied in between)
const REPEAT_AFTER_UNKNOWN_M = 500;
// A section that starts at the very beginning of the route gets its sign this far
// along instead, so it doesn't sit on top of the start pin
const START_OFFSET_M = 60;

// ---------- Types ----------

// What we could honestly work out about a road's limit:
//  known         a speed in mph (e.g. "30 mph", "gb:nsl_single"). The only kind we draw as a UK sign.
//  assumed-unit  a bare number like "50": OSM says that means km/h. Kept, never drawn as UK mph.
//  other-unit    an explicit km/h value. Kept, not drawn on a UK mph sign.
//  multiple      something like "50;70". Ambiguous, kept, not drawn.
//  symbolic      "signals", "national", "none", ... no single number. Kept, not drawn.
//  unknown       OSM has no maxspeed for this road.
export type LimitStatus =
  | "known"
  | "assumed-unit"
  | "other-unit"
  | "multiple"
  | "symbolic"
  | "unknown";

// One continuous stretch of the route with one effective limit
export type SpeedLimitSection = {
  status: LimitStatus;
  mph: number | null; // set only when status is "known"
  value: number | null; // the number OSM gave, in its own unit (null if there is none)
  unit: SpeedUnit | null;
  raw: string | null; // exactly what OSM said
  startMeters: number; // measured along the route
  endMeters: number;
  lengthMeters: number;
};

// A sign to draw: the start of a new speed-limit section
export type SpeedLimitSign = {
  id: string;
  mph: number;
  lon: number;
  lat: number;
  atMeters: number; // where along the route the sign sits
  sectionStartMeters: number;
  raw: string | null;
};

// The only things we need from a road section (RouteRoad fits this)
export type LimitedRoad = {
  startMeters: number;
  endMeters: number;
  maxspeed: SpeedLimit | null;
};

// ---------- Working out the limit of one road ----------

type Classified = Pick<SpeedLimitSection, "status" | "mph" | "value" | "unit" | "raw">;

function classify(limit: SpeedLimit | null): Classified {
  if (!limit) return { status: "unknown", mph: null, value: null, unit: null, raw: null };

  switch (limit.kind) {
    case "numeric": {
      const { value, unit, unitAssumed } = limit.speed;
      const base = { value, unit, raw: limit.raw };
      if (unitAssumed) return { ...base, status: "assumed-unit", mph: null };
      if (unit === "mph") return { ...base, status: "known", mph: value };
      return { ...base, status: "other-unit", mph: null };
    }
    case "multiple":
      return { status: "multiple", mph: null, value: null, unit: null, raw: limit.raw };
    case "symbolic":
      return { status: "symbolic", mph: null, value: null, unit: null, raw: limit.raw };
  }
}

// Two roads belong in the same section when they have the same effective limit
function sameLimit(a: Classified, b: Classified): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "known") return a.mph === b.mph; // "30 mph" and gb:nsl_restricted are both 30
  return a.raw === b.raw;
}

// ---------- Building the sections ----------

// Roads are in driving order. Neighbours with the same effective limit are merged,
// so a long run of 30 mph streets becomes ONE section.
export function buildSpeedLimitSections(roads: LimitedRoad[]): SpeedLimitSection[] {
  const ordered = [...roads].sort((a, b) => a.startMeters - b.startMeters);
  const sections: SpeedLimitSection[] = [];

  for (const road of ordered) {
    const info = classify(road.maxspeed);
    const last = sections[sections.length - 1];

    if (last && sameLimit(last, info) && road.startMeters - last.endMeters <= MERGE_GAP_M) {
      last.endMeters = Math.max(last.endMeters, road.endMeters);
      last.lengthMeters = last.endMeters - last.startMeters;
      continue;
    }

    sections.push({
      ...info,
      startMeters: road.startMeters,
      endMeters: road.endMeters,
      lengthMeters: road.endMeters - road.startMeters,
    });
  }

  return sections;
}

// ---------- Placing signs on the route line ----------

// The point a given distance along the route, found on the route's own line.
// `cumulative[i]` is how many metres along the route coords[i] is.
function pointAtDistance(coords: Coord[], cumulative: number[], meters: number): Coord | null {
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const start = cumulative[i - 1];
    const end = cumulative[i];
    if (!a || !b || start === undefined || end === undefined) continue;

    if (end >= meters) {
      const length = end - start;
      const t = length > 0 ? Math.min(1, Math.max(0, (meters - start) / length)) : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return coords[coords.length - 1] ?? null;
}

// One sign at the START of each new, known, mph limit section.
export function buildSpeedLimitSigns(
  sections: SpeedLimitSection[],
  coords: Coord[],
  cumulative: number[]
): SpeedLimitSign[] {
  const signs: SpeedLimitSign[] = [];
  let lastShownMph: number | null = null; // the limit of the last sign we drew
  let lastKnownEnd = -Infinity; // where the most recent known section ended

  for (const section of sections) {
    // Only limits we truly know in mph get a UK sign. Everything else is skipped.
    if (section.status !== "known" || section.mph === null) continue;

    // How much route with no usable limit lies between the last known section and this one
    const unknownGap = section.startMeters - lastKnownEnd;
    lastKnownEnd = section.endMeters;

    if (section.lengthMeters < MIN_SIGN_SECTION_M) continue;

    const changed = lastShownMph === null || section.mph !== lastShownMph;
    const returnedAfterUnknown = unknownGap >= REPEAT_AFTER_UNKNOWN_M;
    if (!changed && !returnedAfterUnknown) continue;

    const at =
      section.startMeters < START_OFFSET_M
        ? Math.min(START_OFFSET_M, (section.startMeters + section.endMeters) / 2)
        : section.startMeters;

    const point = pointAtDistance(coords, cumulative, at);
    if (!point) continue;

    signs.push({
      id: `${Math.round(at)}-${section.mph}`,
      mph: section.mph,
      lon: point[0],
      lat: point[1],
      atMeters: at,
      sectionStartMeters: section.startMeters,
      raw: section.raw,
    });
    lastShownMph = section.mph;
  }

  return signs;
}