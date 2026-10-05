import type { SearchResult } from "./SearchBox";

// The one place favourites are stored in this browser. No account, no server.
export const FAVOURITES_STORAGE_KEY = "veode:favourite-routes";
const MAX_FAVOURITES = 50;

export type FavouritePlace = { name: string; lat: number; lon: number };

export type FavouriteRoute = {
  id: string;
  name: string; // the user's own name, e.g. "Home → Heathrow"
  start: FavouritePlace;
  destination: FavouritePlace;
  createdAt: number; // ms since 1970
  updatedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPlace(value: unknown): FavouritePlace | null {
  if (!isRecord(value)) return null;
  const { name, lat, lon } = value;
  if (typeof name !== "string" || typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name, lat, lon };
}

// Anything that doesn't look right is skipped, never guessed
function readFavourite(value: unknown): FavouriteRoute | null {
  if (!isRecord(value)) return null;
  const { id, name, createdAt, updatedAt } = value;
  const start = readPlace(value.start);
  const destination = readPlace(value.destination);
  if (typeof id !== "string" || id === "" || typeof name !== "string") return null;
  if (!start || !destination) return null;
  const created = typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0;
  const updated = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : created;
  return { id, name, start, destination, createdAt: created, updatedAt: updated };
}

// Reads the saved list. Missing, corrupted or blocked storage gives an empty list.
export function loadFavourites(): FavouriteRoute[] {
  try {
    const text = window.localStorage.getItem(FAVOURITES_STORAGE_KEY);
    if (!text) return [];
    const json: unknown = JSON.parse(text);
    if (!Array.isArray(json)) return [];
    const items: unknown[] = json;
    return items
      .map(readFavourite)
      .filter((favourite): favourite is FavouriteRoute => favourite !== null);
  } catch {
    return [];
  }
}

// Returns false if the browser refused (private mode, storage full, ...)
export function saveFavourites(list: FavouriteRoute[]): boolean {
  try {
    window.localStorage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toPlace(result: SearchResult): FavouritePlace {
  return { name: result.name, lat: result.lat, lon: result.lon };
}

// Each function reads the latest saved list first, so two open tabs don't overwrite each other.
// They return the list to show. If saving failed, `saved` is false and the list is unchanged.
export type FavouritesChange = { items: FavouriteRoute[]; saved: boolean };

export function addFavourite(
  name: string,
  start: SearchResult,
  destination: SearchResult
): FavouritesChange {
  const current = loadFavourites();
  const now = Date.now();
  const favourite: FavouriteRoute = {
    id: makeId(),
    name,
    start: toPlace(start),
    destination: toPlace(destination),
    createdAt: now,
    updatedAt: now,
  };
  const next = [favourite, ...current].slice(0, MAX_FAVOURITES);
  const saved = saveFavourites(next);
  return { items: saved ? next : current, saved };
}

export function removeFavourite(id: string): FavouritesChange {
  const current = loadFavourites();
  const next = current.filter((favourite) => favourite.id !== id);
  const saved = saveFavourites(next);
  return { items: saved ? next : current, saved };
}

export function updateFavourite(id: string, changes: { name?: string }): FavouritesChange {
  const current = loadFavourites();
  const next = current.map((favourite) =>
    favourite.id === id
      ? { ...favourite, ...changes, updatedAt: Date.now() }
      : favourite
  );
  const saved = saveFavourites(next);
  return { items: saved ? next : current, saved };
}

// Turns a saved place back into the same shape the search box produces, so the
// normal routing flow can use it. The small box around the point only decides the zoom.
export function placeFromFavourite(place: FavouritePlace, id: number): SearchResult {
  const pad = 0.003;
  return {
    id,
    name: place.name,
    lat: place.lat,
    lon: place.lon,
    bounds: [place.lon - pad, place.lat - pad, place.lon + pad, place.lat + pad],
  };
}