import { asString, isRecord } from "./dbParse";

// The accounts remembered on this device, so you can switch without typing passwords.
// Only a REFRESH token is kept (never the password, never an access token). See the
// security notes: browser storage is readable by any script running on this site.
export const SAVED_ACCOUNTS_KEY = "veode:saved-accounts";
export const MAX_ACCOUNTS = 3;

export type SavedAccount = {
  userId: string;
  username: string;
  avatarId: string;
  refreshToken: string; // "" once it has stopped working
  needsSignIn: boolean; // true = must type the password again
};

export function loadSaved(): SavedAccount[] {
  try {
    const text = window.localStorage.getItem(SAVED_ACCOUNTS_KEY);
    if (!text) return [];
    const json: unknown = JSON.parse(text);
    if (!Array.isArray(json)) return [];
    const items: unknown[] = json;

    const out: SavedAccount[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const userId = asString(item.userId);
      const username = asString(item.username);
      const avatarId = asString(item.avatarId);
      const refreshToken = asString(item.refreshToken);
      if (userId === null || username === null || refreshToken === null) continue;
      if (out.some((a) => a.userId === userId)) continue;
      out.push({
        userId,
        username,
        avatarId: avatarId ?? "avatar_01",
        refreshToken,
        needsSignIn: item.needsSignIn === true || refreshToken === "",
      });
    }
    return out.slice(0, MAX_ACCOUNTS);
  } catch {
    return [];
  }
}

export function writeSaved(list: SavedAccount[]): void {
  try {
    window.localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: accounts still work for this visit, they just won't be remembered
  }
}