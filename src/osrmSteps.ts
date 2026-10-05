import type { Coord } from "./routeGeometry";
import type { ManeuverKind } from "./navigationTypes";
import { pathLengthMeters } from "./routeMatching";

// One instruction of the route, in Veode's own form
export type RouteStep = {
  kind: ManeuverKind;
  instruction: string;
  // false for steps that are not worth announcing: the start, and the join where a
  // forced detour waypoint was inserted
  announce: boolean;
  startMeters: number; // where the maneuver happens, along the route line
  lengthMeters: number; // distance until the next maneuver
  durationSeconds: number;
  road: string | null;
  osrmType: string;
  osrmModifier: string | null;
  location: Coord | null;
};

// The parts of OSRM's reply that we read
type OsrmManeuver = {
  type?: string;
  modifier?: string;
  exit?: number;
  location?: [number, number];
};
type OsrmStep = {
  distance?: number;
  duration?: number;
  name?: string;
  ref?: string;
  exits?: string;
  maneuver?: OsrmManeuver;
};
export type OsrmLeg = { steps?: OsrmStep[] };

function roadLabel(name: string | undefined, ref: string | undefined): string | null {
  const n = name?.trim() ?? "";
  const r = ref?.trim() ?? "";
  if (n && r) return `${n} (${r})`;
  return n || r || null;
}

function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? "th"}`;
}

function side(modifier: string | null): "left" | "right" | null {
  if (modifier?.includes("left")) return "left";
  if (modifier?.includes("right")) return "right";
  return null;
}

function words(modifier: string | null): string {
  switch (modifier) {
    case "slight left":
      return "slightly left";
    case "slight right":
      return "slightly right";
    case "sharp left":
      return "sharp left";
    case "sharp right":
      return "sharp right";
    case "left":
      return "left";
    case "right":
      return "right";
    default:
      return "";
  }
}

// keep = the maneuver is "keep left/right" style, so sharp turns draw as gentle arrows
function kindFor(modifier: string | null, keep = false): ManeuverKind {
  switch (modifier) {
    case "left":
    case "sharp left":
      return keep ? "slight-left" : "left";
    case "slight left":
      return "slight-left";
    case "right":
    case "sharp right":
      return keep ? "slight-right" : "right";
    case "slight right":
      return "slight-right";
    case "uturn":
      return "u-turn";
    default:
      return "straight";
  }
}

// Turns OSRM's maneuver into text + an icon kind. OSRM decides WHAT the maneuver is;
// this only words it. Nothing is guessed from the route shape.
function describe(
  type: string,
  modifier: string | null,
  exit: number | undefined,
  exits: string | undefined,
  road: string | null
): { kind: ManeuverKind; text: string } {
  const onto = road ? ` onto ${road}` : "";
  const s = side(modifier);

  switch (type) {
    case "turn":
      if (modifier === "uturn") return { kind: "u-turn", text: `Make a U-turn${onto}` };
      if (modifier === null || modifier === "straight") {
        return { kind: "straight", text: `Continue straight${onto}` };
      }
      return { kind: kindFor(modifier), text: `Turn ${words(modifier)}${onto}` };
    case "new name":
      return { kind: kindFor(modifier, true), text: `Continue${onto}` };
    case "continue":
      if (modifier === "uturn") return { kind: "u-turn", text: `Make a U-turn${onto}` };
      if (modifier === null || modifier === "straight") {
        return { kind: "straight", text: `Continue straight${onto}` };
      }
      return { kind: kindFor(modifier, true), text: `Continue ${words(modifier)}${onto}` };
    case "end of road":
      return {
        kind: kindFor(modifier),
        text: s ? `At the end of the road, turn ${s}${onto}` : `At the end of the road, continue${onto}`,
      };
    case "fork":
      return { kind: kindFor(modifier, true), text: `Keep ${s ?? "straight"}${onto}` };
    case "merge":
      return { kind: kindFor(modifier, true), text: `Merge${s ? ` ${s}` : ""}${onto}` };
    case "on ramp":
      return {
        kind: kindFor(modifier, true),
        text: `Take the slip road${s ? ` on the ${s}` : ""}${onto}`,
      };
    case "off ramp":
      return {
        kind: kindFor(modifier, true),
        text: `${exits ? `Take exit ${exits}` : "Take the exit"}${s ? ` on the ${s}` : ""}${onto}`,
      };
    case "roundabout":
    case "rotary":
      return {
        kind: "roundabout",
        text:
          exit !== undefined
            ? `At the roundabout, take the ${ordinal(exit)} exit${onto}`
            : `Enter the roundabout${onto}`,
      };
    case "roundabout turn":
      return {
        kind: kindFor(modifier),
        text:
          modifier === null || modifier === "straight"
            ? `At the roundabout, continue straight${onto}`
            : `At the roundabout, turn ${words(modifier)}${onto}`,
      };
    case "arrive":
      return {
        kind: "arrive",
        text: s ? `Arrive at your destination, on the ${s}` : "Arrive at your destination",
      };
    case "depart":
      return { kind: "straight", text: road ? `Start on ${road}` : "Start" };
    default:
      return { kind: "straight", text: `Continue${onto}` };
  }
}

const NOT_ANNOUNCED = new Set(["depart", "exit roundabout", "exit rotary", "notification"]);

// Reads OSRM's legs/steps. Positions are measured along the route line with the same
// ruler GPS matching uses (OSRM's own distances are rescaled to it).
export function parseOsrmSteps(legs: OsrmLeg[] | undefined, coords: Coord[]): RouteStep[] {
  if (!legs || legs.length === 0) return [];

  let osrmTotal = 0;
  for (const leg of legs) {
    for (const step of leg.steps ?? []) osrmTotal += step.distance ?? 0;
  }
  const geometryLength = pathLengthMeters(coords);
  if (osrmTotal <= 0 || geometryLength <= 0) return [];
  const scale = geometryLength / osrmTotal;

  const steps: RouteStep[] = [];
  let cumulative = 0;

  legs.forEach((leg, legIndex) => {
    for (const raw of leg.steps ?? []) {
      const type = raw.maneuver?.type ?? "continue";
      const modifier = raw.maneuver?.modifier ?? null;
      const road = roadLabel(raw.name, raw.ref);
      const length = (raw.distance ?? 0) * scale;

      // A forced detour waypoint creates an "arrive" then a "depart" in the middle of the
      // route. They are artefacts of how Veode asked, not real maneuvers, so never announce them.
      const isViaPoint =
        (type === "arrive" && legIndex < legs.length - 1) || (type === "depart" && legIndex > 0);

      const { kind, text } = describe(type, modifier, raw.maneuver?.exit, raw.exits, road);

      steps.push({
        kind,
        instruction: text,
        announce: !isViaPoint && !NOT_ANNOUNCED.has(type),
        startMeters: cumulative,
        lengthMeters: length,
        durationSeconds: raw.duration ?? 0,
        road,
        osrmType: type,
        osrmModifier: modifier,
        location: raw.maneuver?.location ?? null,
      });
      cumulative += length;
    }
  });

  return steps;
}