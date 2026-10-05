// Safe parsers for OpenStreetMap tag values. OSM is hand-edited, so every
// value can be missing or odd. Unknown stays unknown (null); nothing is invented.

export type SpeedUnit = "mph" | "kmh";

export type SpeedValue = {
  value: number;
  unit: SpeedUnit;
  // true when OSM gave a bare number like "50" and we had to assume the unit
  unitAssumed: boolean;
};

export type SpeedLimit =
  | { kind: "numeric"; raw: string; speed: SpeedValue } // "30 mph", "70"
  | { kind: "multiple"; raw: string; speeds: SpeedValue[] } // "50;70"
  | { kind: "symbolic"; raw: string }; // "signals", "national", "none", ...

// OSM's own rule: a number with no unit means km/h. UK mappers are supposed to
// write "30 mph", but a bare number can appear. We follow the OSM rule and flag
// it with unitAssumed. If you find bare numbers on UK roads are really mph,
// change this one line to "mph".
const BARE_NUMBER_UNIT: SpeedUnit = "kmh";

// Official UK values that have a fixed, known meaning (lower-case keys)
const UK_DEFAULTS_MPH: Record<string, number> = {
  "gb:nsl_single": 60,
  "gb:nsl_dual": 70,
  "gb:motorway": 70,
  "gb:nsl_restricted": 30,
};

function parseSpeedValue(part: string): SpeedValue | null {
  const text = part.trim();

  const match = /^(\d{1,3})(?:\s*(mph|km\/h|kmh|kph))?$/i.exec(text);
  if (match) {
    const digits = match[1];
    if (!digits) return null;
    const value = Number(digits);
    if (value <= 0) return null;

    const unitText = match[2]?.toLowerCase();
    if (unitText === "mph") return { value, unit: "mph", unitAssumed: false };
    if (unitText) return { value, unit: "kmh", unitAssumed: false };
    return { value, unit: BARE_NUMBER_UNIT, unitAssumed: true };
  }

  const uk = UK_DEFAULTS_MPH[text.toLowerCase()];
  if (uk !== undefined) return { value: uk, unit: "mph", unitAssumed: false };

  return null;
}

export function parseMaxspeed(raw: string | null | undefined): SpeedLimit | null {
  const text = raw?.trim();
  if (!text) return null;

  if (text.includes(";")) {
    const parts = text.split(";").map(parseSpeedValue);
    const valid = parts.filter((p): p is SpeedValue => p !== null);
    if (valid.length === parts.length && valid.length > 1) {
      return { kind: "multiple", raw: text, speeds: valid };
    }
    return { kind: "symbolic", raw: text };
  }

  const single = parseSpeedValue(text);
  return single
    ? { kind: "numeric", raw: text, speed: single }
    : { kind: "symbolic", raw: text };
}

function formatSpeed(speed: SpeedValue): string {
  return `${speed.value} ${speed.unit === "mph" ? "mph" : "km/h"}`;
}

// A short readable label, or null when there is nothing honest to show
export function speedLimitLabel(limit: SpeedLimit | null): string | null {
  if (!limit) return null;
  switch (limit.kind) {
    case "numeric":
      return formatSpeed(limit.speed);
    case "multiple":
      return limit.speeds.map(formatSpeed).join(" / ");
    case "symbolic": {
      const raw = limit.raw.toLowerCase();
      if (raw === "signals") return "Variable (shown on signs)";
      if (raw === "none") return "No speed limit mapped";
      return null; // "national", "walk", ... have no single number we can state
    }
  }
}

// True when the label above relies on a unit we assumed
export function speedUnitWasAssumed(limit: SpeedLimit | null): boolean {
  if (!limit) return false;
  if (limit.kind === "numeric") return limit.speed.unitAssumed;
  if (limit.kind === "multiple") return limit.speeds.some((s) => s.unitAssumed);
  return false;
}

// For the future navigation phase: one clear number in mph, or null if unclear
export function speedLimitMph(limit: SpeedLimit | null): number | null {
  if (!limit || limit.kind !== "numeric") return null;
  const { value, unit } = limit.speed;
  return unit === "mph" ? value : Math.round(value * 0.621371);
}

// ---------- Other tags ----------

export function cleanTag(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function parseLanes(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !/^\d{1,2}$/.test(text)) return null;
  const lanes = Number(text);
  return lanes > 0 ? lanes : null;
}

// yes -> true, no -> false, anything else (including missing) -> null.
// We do NOT assume motorways are one-way when the tag is missing.
// "-1" and "reverse" mean one-way against the drawn direction: still one-way.
export function parseOneway(value: string | undefined): boolean | null {
  const text = value?.trim().toLowerCase();
  if (text === "yes" || text === "true" || text === "1" || text === "-1" || text === "reverse") {
    return true;
  }
  if (text === "no" || text === "false" || text === "0") return false;
  return null;
}

// bridge=yes / viaduct / cantilever ... all count; bridge=no or missing does not
export function parseFlag(value: string | undefined): boolean {
  const text = value?.trim().toLowerCase();
  return text !== undefined && text !== "" && text !== "no";
}