import type { Route, RouteType } from "./routing";
import type { Candidate } from "./routeCandidates";
import { getBounds, routeSimilarity } from "./routeGeometry";

// ---------- Settings you can tweak later ----------

// Two routes that share more than this much of their road count as "the same route"
const MAX_SIMILARITY = 0.8;
// The motorway-free route is the whole point of its card, so it is only dropped
// when it is practically identical to another route (the fastest one already
// avoids motorways, for example)
const NEAR_IDENTICAL = 0.97;
// An alternative may be at most this many times slower / longer than the fastest
const MAX_SLOWER = 1.5;
const MAX_LONGER = 1.6;
// Avoiding motorways can honestly cost a lot of time, so it gets more room
const MAX_SLOWER_NO_MOTORWAY = 2.5;
// Routes that double back over themselves more than this are thrown away
const MAX_RETRACE = 0.04;
// How many "Alternative" cards to show at most
const MAX_ALTERNATIVES = 2;

// ---------- Scoring (the future intelligence layer) ----------

// A scorer looks at a candidate and returns a number (bigger = better), or null
// meaning "I have no data to judge this route". A null score never wins.
export type Scorer = (candidate: Candidate) => number | null;

// SCENIC: needs OpenStreetMap data along the route: forest, parks, rivers, lakes,
// coastline and countryside (good), against dense urban areas and industry (bad).
// We have none of that yet, so we do NOT guess. Always null for now.
export const scoreScenic: Scorer = () => null;
export const MIN_SCENIC_SCORE = 0.5;

// FUN: needs the road itself: bends per kilometre, road class, number of
// junctions and traffic lights, urban density, motorway share, speed limits.
// The route line alone is not enough to judge this honestly. Null for now.
export const scoreFun: Scorer = () => null;
export const MIN_FUN_SCORE = 0.5;

// ---------- Comparing routes ----------

// Is this candidate genuinely different from every route already chosen?
function isDistinct(
  candidate: Candidate,
  chosen: Candidate[],
  maxSimilarity: number
): boolean {
  return chosen.every(
    (other) => routeSimilarity(candidate.prepared, other.prepared) < maxSimilarity
  );
}

// Is this candidate not absurdly slower or longer than the fastest route?
function isCompetitive(candidate: Candidate, fastest: Candidate): boolean {
  return (
    candidate.durationSeconds <= fastest.durationSeconds * MAX_SLOWER &&
    candidate.distanceMeters <= fastest.distanceMeters * MAX_LONGER
  );
}

// The candidate with the best score at or above minScore (null if none qualifies)
function pickBest(
  pool: Candidate[],
  scorer: Scorer,
  minScore: number
): Candidate | null {
  let best: Candidate | null = null;
  let bestScore = minScore;
  for (const candidate of pool) {
    const score = scorer(candidate);
    if (score !== null && score >= bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ---------- Turning candidates into the final cards ----------

type Chosen = { type: RouteType; candidate: Candidate };

function labelFor(
  type: RouteType,
  alternativeNumber: number
): { id: string; name: string } {
  switch (type) {
    case "fastest":
      return { id: "fastest", name: "Fastest" };
    case "avoid-motorways":
      return { id: "avoid-motorways", name: "Avoid Motorways" };
    case "scenic":
      return { id: "scenic", name: "Scenic" };
    case "fun":
      return { id: "fun", name: "Fun Drive" };
    case "alternative":
      return {
        id: `alternative-${alternativeNumber}`,
        name: alternativeNumber === 1 ? "Alternative" : `Alternative ${alternativeNumber}`,
      };
  }
}

function toRoute(chosen: Chosen, alternativeNumber: number): Route {
  const { id, name } = labelFor(chosen.type, alternativeNumber);
  const { candidate } = chosen;
  return {
    id,
    name,
    type: chosen.type,
    mode: "car",
    geometry: candidate.geometry,
    distanceMeters: candidate.distanceMeters,
    durationSeconds: candidate.durationSeconds,
    bounds: getBounds(candidate.geometry.coordinates),
  };
}

// Decides which candidates become route cards, and what each one is called.
// Order of the result: Fastest, Avoid Motorways, Scenic, Fun Drive, Alternatives.
export function classifyRoutes(candidates: Candidate[]): Route[] {
  // Throw away routes that run out and double back (unless that leaves nothing)
  const sensible = candidates.filter((c) => c.retrace <= MAX_RETRACE);
  const pool = sensible.length > 0 ? sensible : candidates;

  // FASTEST: simply the lowest duration
  const [first, ...others] = pool;
  if (!first) return [];
  const fastest = others.reduce(
    (best, c) => (c.durationSeconds < best.durationSeconds ? c : best),
    first
  );

  const chosen: Chosen[] = [{ type: "fastest", candidate: fastest }];
  const taken = () => chosen.map((c) => c.candidate);
  let remaining = pool.filter((c) => c !== fastest);

  // AVOID MOTORWAYS: only a route OSRM really calculated with motorways switched off
  const noMotorway = remaining.find((c) => c.source === "no-motorway");
  if (
    noMotorway &&
    noMotorway.durationSeconds <= fastest.durationSeconds * MAX_SLOWER_NO_MOTORWAY &&
    isDistinct(noMotorway, taken(), NEAR_IDENTICAL)
  ) {
    chosen.push({ type: "avoid-motorways", candidate: noMotorway });
  }
  // Either way it must not come back as an "Alternative"
  remaining = remaining.filter((c) => c.source !== "no-motorway");

  const competitive = remaining.filter((c) => isCompetitive(c, fastest));

  // SCENIC and FUN: only when a scorer has real data that says so (not yet)
  const scenic = pickBest(competitive, scoreScenic, MIN_SCENIC_SCORE);
  if (scenic && isDistinct(scenic, taken(), MAX_SIMILARITY)) {
    chosen.push({ type: "scenic", candidate: scenic });
  }
  const fun = pickBest(
    competitive.filter((c) => c !== scenic),
    scoreFun,
    MIN_FUN_SCORE
  );
  if (fun && isDistinct(fun, taken(), MAX_SIMILARITY)) {
    chosen.push({ type: "fun", candidate: fun });
  }

  // ALTERNATIVE: genuinely different, reasonably competitive, quickest first
  const byDuration = [...competitive].sort(
    (a, b) => a.durationSeconds - b.durationSeconds
  );
  let alternatives = 0;
  for (const candidate of byDuration) {
    if (alternatives >= MAX_ALTERNATIVES) break;
    if (taken().includes(candidate)) continue;
    if (!isDistinct(candidate, taken(), MAX_SIMILARITY)) continue;
    chosen.push({ type: "alternative", candidate });
    alternatives++;
  }

  let alternativeNumber = 0;
  return chosen.map((entry) => {
    if (entry.type === "alternative") alternativeNumber++;
    return toRoute(entry, alternativeNumber);
  });
}