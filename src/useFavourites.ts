import { useCallback, useEffect, useState } from "react";
import {
  FAVOURITES_STORAGE_KEY,
  addFavourite as addLocal,
  loadFavourites,
  removeFavourite as removeLocal,
  saveFavourites,
  type FavouritePlace,
  type FavouriteRoute,
} from "./favourites";
import {
  deleteRemoteFavourite,
  fetchRemoteFavourites,
  importRemoteFavourites,
  insertRemoteFavourite,
} from "./favouritesRemote";
import type { SearchResult } from "./SearchBox";

type Remote = { accountId: string; items: FavouriteRoute[]; error: string | null };

// One place that decides where favourites live:
//  * signed in  -> this ACCOUNT's rows in Supabase (so accounts never share favourites)
//  * signed out -> this browser's localStorage (the old behaviour)
// Every function returns an error message, or null when it worked.
export function useFavourites(accountId: string | null, active: boolean) {
  const [local, setLocal] = useState<FavouriteRoute[]>(() => loadFavourites());
  const [remote, setRemote] = useState<Remote | null>(null);

  // The local list changed in another tab
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === FAVOURITES_STORAGE_KEY || event.key === null) setLocal(loadFavourites());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Load the account's favourites whenever the panel is open (and the account changes)
  useEffect(() => {
    if (accountId === null || !active) return;
    let cancelled = false;
    void fetchRemoteFavourites().then((result) => {
      if (cancelled) return;
      setRemote({
        accountId,
        items: result.ok ? result.data : [],
        error: result.ok ? null : result.message,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, active]);

  // Only ever show remote data that belongs to the CURRENT account
  const remoteReady = accountId !== null && remote !== null && remote.accountId === accountId;
  const items: FavouriteRoute[] = accountId === null ? local : remoteReady ? remote.items : [];
  const loading = accountId !== null && !remoteReady;
  const error = remoteReady ? remote.error : null;

  const add = useCallback(
    async (name: string, start: SearchResult, destination: SearchResult): Promise<string | null> => {
      if (accountId === null) {
        const change = addLocal(name, start, destination);
        setLocal(change.items);
        return change.saved ? null : "Couldn't save. Your browser is blocking storage for this site.";
      }
      const result = await insertRemoteFavourite(name, start, destination);
      if (!result.ok) return result.message;
      setRemote((prev) =>
        prev && prev.accountId === accountId ? { ...prev, items: [result.data, ...prev.items] } : prev
      );
      return null;
    },
    [accountId]
  );

  const remove = useCallback(
    async (id: string): Promise<string | null> => {
      if (accountId === null) {
        const change = removeLocal(id);
        setLocal(change.items);
        return change.saved ? null : "Couldn't update the saved list.";
      }
      const result = await deleteRemoteFavourite(id);
      if (!result.ok) return result.message;
      setRemote((prev) =>
        prev && prev.accountId === accountId
          ? { ...prev, items: prev.items.filter((item) => item.id !== id) }
          : prev
      );
      return null;
    },
    [accountId]
  );

  // Moves this device's local favourites into the signed-in account, then clears the local copy
  const importLocal = useCallback(async (): Promise<string | null> => {
    if (accountId === null) return null;
    const result = await importRemoteFavourites(local);
    if (!result.ok) return result.message;
    saveFavourites([]);
    setLocal([]);
    setRemote((prev) =>
      prev && prev.accountId === accountId
        ? { ...prev, items: [...result.data, ...prev.items] }
        : prev
    );
    return null;
  }, [accountId, local]);

  return { items, loading, error, add, remove, importLocal, localCount: local.length };
}

export type { FavouritePlace };