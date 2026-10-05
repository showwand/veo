// Small helpers for reading data from Supabase safely. Anything that doesn't have the
// expected shape is skipped, never guessed.

export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Turns a list of rows into a list of typed items, dropping rows that don't parse
export function parseList<T>(
  data: unknown,
  parse: (row: Record<string, unknown>) => T | null
): T[] {
  if (!Array.isArray(data)) return [];
  const rows: unknown[] = data;
  const out: T[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const item = parse(row);
    if (item !== null) out.push(item);
  }
  return out;
}