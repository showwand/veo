import { supabase } from "./supabaseClient";
import { describeError } from "./accountErrors";
import { asNumber, asString, parseList, type ApiResult } from "./dbParse";
import type { FavouritePlace, FavouriteRoute } from "./favourites";

// Favourite routes stored in Supabase. Row Level Security means a signed-in account can
// only ever read or change its OWN rows, whatever the browser asks for.

const COLUMNS = "id, name, start_name, start_lat, start_lon, dest_name, dest_lat, dest_lon, created_at, updated_at";

function toMillis(value: unknown): number {
  const text = asString(value);
  const parsed = text === null ? Number.NaN : Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseRow(row: Record<string, unknown>): FavouriteRoute | null {
  const id = asString(row.id);
  const name = asString(row.name);
  const startName = asString(row.start_name);
  const destName = asString(row.dest_name);
  const startLat = asNumber(row.start_lat);
  const startLon = asNumber(row.start_lon);
  const destLat = asNumber(row.dest_lat);
  const destLon = asNumber(row.dest_lon);
  if (id === null || name === null || startName === null || destName === null) return null;
  if (startLat === null || startLon === null || destLat === null || destLon === null) return null;
  return {
    id,
    name,
    start: { name: startName, lat: startLat, lon: startLon },
    destination: { name: destName, lat: destLat, lon: destLon },
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function toRow(name: string, start: FavouritePlace, destination: FavouritePlace) {
  return {
    name,
    start_name: start.name,
    start_lat: start.lat,
    start_lon: start.lon,
    dest_name: destination.name,
    dest_lat: destination.lat,
    dest_lon: destination.lon,
  };
}

const OFFLINE = "Supabase isn't set up yet.";

export async function fetchRemoteFavourites(): Promise<ApiResult<FavouriteRoute[]>> {
  if (!supabase) return { ok: false, message: OFFLINE };
  try {
    const result = await supabase
      .from("favourite_routes")
      .select(COLUMNS)
      .order("created_at", { ascending: false });
    if (result.error) return { ok: false, message: describeError(result.error) };
    return { ok: true, data: parseList(result.data, parseRow) };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function insertRemoteFavourite(
  name: string,
  start: FavouritePlace,
  destination: FavouritePlace
): Promise<ApiResult<FavouriteRoute>> {
  if (!supabase) return { ok: false, message: OFFLINE };
  try {
    const result = await supabase
      .from("favourite_routes")
      .insert(toRow(name, start, destination))
      .select(COLUMNS)
      .single();
    if (result.error) return { ok: false, message: describeError(result.error) };
    const rows = parseList([result.data], parseRow);
    const created = rows[0];
    return created ? { ok: true, data: created } : { ok: false, message: "Couldn't save the route." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function deleteRemoteFavourite(id: string): Promise<ApiResult<null>> {
  if (!supabase) return { ok: false, message: OFFLINE };
  try {
    const result = await supabase.from("favourite_routes").delete().eq("id", id);
    if (result.error) return { ok: false, message: describeError(result.error) };
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

// One-time move of this device's local favourites into the signed-in account
export async function importRemoteFavourites(list: FavouriteRoute[]): Promise<ApiResult<FavouriteRoute[]>> {
  if (!supabase) return { ok: false, message: OFFLINE };
  if (list.length === 0) return { ok: true, data: [] };
  try {
    const result = await supabase
      .from("favourite_routes")
      .insert(list.map((item) => toRow(item.name, item.start, item.destination)))
      .select(COLUMNS);
    if (result.error) return { ok: false, message: describeError(result.error) };
    return { ok: true, data: parseList(result.data, parseRow) };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}