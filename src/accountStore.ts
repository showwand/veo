import { useSyncExternalStore } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createStore } from "./store";
import { callRpc, emailForUsername, supabase } from "./supabaseClient";
import { getDeviceId } from "./deviceId";
import {
  LIMIT_MESSAGE,
  describeAuthError,
  describeError,
  errorMessage,
  isNetworkError,
} from "./accountErrors";
import { DEFAULT_AVATAR_ID, isAvatarId } from "./avatars";
import { normaliseUsername, validatePassword, validateUsername } from "./accountRules";
import {
  MAX_ACCOUNTS,
  SAVED_ACCOUNTS_KEY,
  loadSaved,
  writeSaved,
  type SavedAccount,
} from "./savedAccounts";
import { asString, isRecord } from "./dbParse";

// ---------------------------------------------------------------------------
// HOW ACCOUNTS WORK
// * Every Veode account is its own Supabase Auth user (username + password).
// * Supabase keeps ONE session active at a time. That is "the active account".
// * The other accounts on this device are remembered as refresh tokens
//   (savedAccounts.ts). Switching = trading that token for a fresh session.
// * The database limits a device to 3 accounts (claim_device_slot).
// * Anything that belongs to an account (profile, friends, favourites) is loaded
//   through the ACTIVE account only, and thrown away when the account changes.
// ---------------------------------------------------------------------------

export type AccountProfile = {
  id: string;
  username: string;
  avatarId: string;
  shareLocation: boolean;
};
export type DeviceAccount = { id: string; username: string; avatarId: string; needsSignIn: boolean };

export type AccountState = {
  configured: boolean; // are the Supabase keys present?
  ready: boolean; // has the saved session been looked at yet?
  busy: boolean; // a sign-in / switch is in progress
  activeId: string | null; // the signed-in user, or null
  profile: AccountProfile | null;
  profileError: string | null;
  accounts: DeviceAccount[]; // accounts remembered on this device
  notice: string | null; // e.g. "your session expired"
};

export type ActionResult =
  | { ok: true }
  | { ok: false; message: string; field?: "username" | "password" };

const NOT_CONFIGURED = "Supabase isn't set up yet. Add the keys to .env.local (see the setup notes).";
const NO_EMAIL_TEMPLATE =
  "VITE_AUTH_EMAIL_TEMPLATE is missing or wrong. It must look like {u}@your-domain.com.";

function fail(message: string, field?: "username" | "password"): ActionResult {
  return field ? { ok: false, message, field } : { ok: false, message };
}

function toDevice(list: SavedAccount[]): DeviceAccount[] {
  return list.map((a) => ({
    id: a.userId,
    username: a.username,
    avatarId: a.avatarId,
    needsSignIn: a.needsSignIn,
  }));
}

const store = createStore<AccountState>({
  configured: supabase !== null,
  ready: supabase === null,
  busy: false,
  activeId: null,
  profile: null,
  profileError: null,
  accounts: toDevice(loadSaved()),
  notice: null,
});

export const getAccountState = store.get;
export const subscribeAccounts = store.subscribe;

function patch(change: Partial<AccountState>) {
  store.set({ ...store.get(), ...change });
}

export function useAccountState(): AccountState {
  return useSyncExternalStore(store.subscribe, store.get);
}

// ---------- the saved-accounts list ----------

// Always re-reads storage first, so two open tabs can't overwrite each other
function mutateSaved(change: (list: SavedAccount[]) => SavedAccount[]) {
  const next = change(loadSaved()).slice(0, MAX_ACCOUNTS);
  writeSaved(next);
  patch({ accounts: toDevice(next) });
}

function upsertSaved(entry: SavedAccount) {
  mutateSaved((list) => {
    const index = list.findIndex((a) => a.userId === entry.userId);
    if (index >= 0) {
      const copy = [...list];
      copy[index] = entry;
      return copy;
    }
    return list.length >= MAX_ACCOUNTS ? list : [...list, entry];
  });
}

// Supabase swaps the refresh token every time it refreshes. Reusing an old one revokes the
// session, so the newest token is saved every time.
function keepTokenFresh(session: Session) {
  const id = session.user.id;
  const existing = loadSaved().find((a) => a.userId === id);
  if (!existing) return;
  if (existing.refreshToken === session.refresh_token && !existing.needsSignIn) return;
  mutateSaved((list) =>
    list.map((a) =>
      a.userId === id ? { ...a, refreshToken: session.refresh_token, needsSignIn: false } : a
    )
  );
}

function markNeedsSignIn(id: string) {
  mutateSaved((list) =>
    list.map((a) => (a.userId === id ? { ...a, needsSignIn: true, refreshToken: "" } : a))
  );
}

// ---------- reacting to Supabase sign-in / sign-out events ----------

let started = false;
let version = 0; // goes up whenever the active account changes, so late answers can be ignored
let expectedSignOut = false; // true while WE are signing out (so it isn't reported as "expired")
let subscription: { unsubscribe: () => void } | null = null;

function parseProfile(data: unknown): AccountProfile | null {
  if (!isRecord(data)) return null;
  const id = asString(data.id);
  const username = asString(data.username);
  if (id === null || username === null) return null;
  const avatar = asString(data.avatar_id);
  const shareLocation = typeof data.share_location === "boolean" ? data.share_location : false;
  return {
    id,
    username,
    avatarId: avatar !== null && isAvatarId(avatar) ? avatar : DEFAULT_AVATAR_ID,
    shareLocation,
  };
}

function isMissingProfileColumnError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    /could not find.*share_location.*profiles|column .*share_location.*of relation .*profiles|column .*share_location.*does not exist/i.test(
      message
    ) ||
    (message.includes("share_location") && message.includes("profiles") && message.includes("column"))
  );
}

async function fetchProfile(id: string): Promise<AccountProfile | null> {
  if (!supabase) return null;
  const primary = await supabase
    .from("profiles")
    .select("id, username, avatar_id, share_location")
    .eq("id", id)
    .maybeSingle();

  if (!primary.error) return parseProfile(primary.data);
  if (!isMissingProfileColumnError(primary.error)) throw primary.error;

  const fallback = await supabase
    .from("profiles")
    .select("id, username, avatar_id")
    .eq("id", id)
    .maybeSingle();
  if (fallback.error) throw fallback.error;
  return parseProfile(fallback.data ? { ...fallback.data, share_location: false } : fallback.data);
}

async function loadProfile(id: string, mine: number): Promise<void> {
  const client = supabase;
  if (!client) return;
  try {
    const profile = await fetchProfile(id);
    if (mine !== version) return; // the account changed while we waited
    if (!profile) {
      patch({ profileError: "Couldn't find this account's profile." });
      return;
    }
    patch({ profile, profileError: null });

    // keep the device list in step with the real profile
    const sessionResult = await client.auth.getSession();
    if (mine !== version) return;
    const existing = loadSaved().find((a) => a.userId === id);
    const token = sessionResult.data.session?.refresh_token ?? existing?.refreshToken ?? "";
    if (token !== "") {
      upsertSaved({
        userId: id,
        username: profile.username,
        avatarId: profile.avatarId,
        refreshToken: token,
        needsSignIn: false,
      });
    }
  } catch (error) {
    if (mine === version) patch({ profileError: describeError(error) });
  }
}

// NOTE: no awaiting in here. Supabase holds a lock while this runs, and calling it again
// from inside would freeze. Anything slow is started with a timer instead.
function onAuthEvent(event: AuthChangeEvent, session: Session | null) {
  if (session) {
    keepTokenFresh(session);
    const id = session.user.id;
    if (store.get().activeId !== id) {
      version += 1;
      const mine = version;
      const cached = loadSaved().find((a) => a.userId === id);
      patch({
        activeId: id,
        profile: cached ? { id, username: cached.username, avatarId: cached.avatarId, shareLocation: false } : null,
        profileError: null,
        ready: true,
      });
      window.setTimeout(() => {
        void loadProfile(id, mine);
      }, 0);
    } else if (!store.get().ready) {
      patch({ ready: true });
    }
    return;
  }

  const previous = store.get().activeId;
  if (previous !== null && event === "SIGNED_OUT" && !expectedSignOut) {
    markNeedsSignIn(previous);
    patch({ notice: "Your session expired. Sign in again to keep using this account." });
  }
  version += 1;
  patch({ activeId: null, profile: null, profileError: null, ready: true });
}

// Call once. Safe to call again.
export function ensureAccountsStarted() {
  if (started) return;
  started = true;
  const client = supabase;
  if (!client) {
    patch({ ready: true });
    return;
  }

  const result = client.auth.onAuthStateChange((event, session) => onAuthEvent(event, session));
  subscription = result.data.subscription;

  // Fallback in case the first event never arrives
  void client.auth.getSession().then(({ data }) => {
    if (!store.get().ready) onAuthEvent("INITIAL_SESSION", data.session);
  });

  // Another tab changed the saved accounts
  window.addEventListener("storage", (event) => {
    if (event.key === SAVED_ACCOUNTS_KEY || event.key === null) {
      patch({ accounts: toDevice(loadSaved()) });
    }
  });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      subscription?.unsubscribe();
    });
  }
}

// ---------- signing out locally without touching the saved list ----------

async function dropSession(): Promise<void> {
  if (!supabase) return;
  expectedSignOut = true;
  try {
    await supabase.auth.signOut({ scope: "local" });
  } finally {
    expectedSignOut = false;
  }
}

// Puts a previously active account back (used when a switch or sign-in goes wrong)
async function restoreAccount(id: string | null): Promise<void> {
  if (!supabase || id === null) return;
  const entry = loadSaved().find((a) => a.userId === id && !a.needsSignIn && a.refreshToken !== "");
  if (!entry) return;
  const { error } = await supabase.auth.refreshSession({ refresh_token: entry.refreshToken });
  if (error && !isNetworkError(error)) markNeedsSignIn(id);
}

function isLimitError(error: unknown): boolean {
  return errorMessage(error).includes("device_limit");
}

// After a NEW session exists: claim a device slot on the server, then remember the account
async function finishNewSession(
  session: Session,
  fallbackUsername: string,
  previousId: string | null
): Promise<ActionResult> {
  const claim = await callRpc("claim_device_slot", { p_device_id: getDeviceId() });
  if (claim.error) {
    // The server says this device is full: undo, and go back to the previous account
    await dropSession();
    await restoreAccount(previousId);
    return fail(isLimitError(claim.error) ? LIMIT_MESSAGE : describeError(claim.error));
  }

  let profile: AccountProfile | null = null;
  try {
    profile = await fetchProfile(session.user.id);
  } catch {
    // the profile will be loaded again in a moment
  }

  upsertSaved({
    userId: session.user.id,
    username: profile?.username ?? fallbackUsername,
    avatarId: profile?.avatarId ?? DEFAULT_AVATAR_ID,
    refreshToken: session.refresh_token,
    needsSignIn: false,
  });
  if (profile && store.get().activeId === session.user.id) patch({ profile, profileError: null });
  return { ok: true };
}

// ---------- actions the UI calls ----------

export async function createAccount(rawUsername: string, password: string): Promise<ActionResult> {
  const client = supabase;
  if (!client) return fail(NOT_CONFIGURED);

  const username = normaliseUsername(rawUsername);
  const usernameError = validateUsername(username);
  if (usernameError) return fail(usernameError, "username");
  const passwordError = validatePassword(password);
  if (passwordError) return fail(passwordError, "password");
  if (loadSaved().length >= MAX_ACCOUNTS) return fail(LIMIT_MESSAGE);
  const email = emailForUsername(username);
  if (!email) return fail(NO_EMAIL_TEMPLATE);
  if (store.get().busy) return fail("Please wait a moment.");

  patch({ busy: true, notice: null });
  const previousId = store.get().activeId;
  try {
    // Friendly early checks. The database enforces both again (trigger and claim_device_slot).
    const room = await callRpc("device_can_add", { p_device_id: getDeviceId() });
    if (room.error) return fail(describeError(room.error));
    if (room.data !== true) return fail(LIMIT_MESSAGE);

    const free = await callRpc("username_available", { p_username: username });
    if (free.error) return fail(describeError(free.error));
    if (free.data !== true) return fail("That username is already taken.", "username");

    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { username } },
    });
    if (error) return fail(describeAuthError(error));
    if (!data.session) {
      return fail(
        "Sign-up needs email confirmation. In Supabase, turn off “Confirm email” (Authentication → Providers → Email)."
      );
    }
    return await finishNewSession(data.session, username, previousId);
  } catch (error) {
    return fail(describeAuthError(error));
  } finally {
    patch({ busy: false });
  }
}

export async function signInAccount(rawUsername: string, password: string): Promise<ActionResult> {
  const client = supabase;
  if (!client) return fail(NOT_CONFIGURED);

  const username = normaliseUsername(rawUsername);
  const usernameError = validateUsername(username);
  if (usernameError) return fail(usernameError, "username");
  if (password === "") return fail("Enter your password.", "password");
  const email = emailForUsername(username);
  if (!email) return fail(NO_EMAIL_TEMPLATE);

  const list = loadSaved();
  if (list.length >= MAX_ACCOUNTS && !list.some((a) => a.username === username)) {
    return fail(LIMIT_MESSAGE);
  }
  if (store.get().busy) return fail("Please wait a moment.");

  patch({ busy: true, notice: null });
  const previousId = store.get().activeId;
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return fail(describeAuthError(error));
    if (!data.session) return fail("Couldn't sign in. Try again.");
    return await finishNewSession(data.session, username, previousId);
  } catch (error) {
    return fail(describeAuthError(error));
  } finally {
    patch({ busy: false });
  }
}

async function switchInner(id: string): Promise<ActionResult> {
  const client = supabase;
  if (!client) return fail(NOT_CONFIGURED);

  const target = loadSaved().find((a) => a.userId === id);
  if (!target) return fail("That account isn't saved on this device.");
  if (target.needsSignIn || target.refreshToken === "") {
    return fail(`${target.username}: please sign in again.`);
  }

  const previousId = store.get().activeId;
  const { data, error } = await client.auth.refreshSession({ refresh_token: target.refreshToken });
  if (error || !data.session) {
    if (error && isNetworkError(error)) return fail("Can't reach Veode's server. Check your connection.");
    markNeedsSignIn(id);
    await restoreAccount(previousId); // a failed refresh can sign the current account out
    return fail(`${target.username}'s session expired. Sign in again.`);
  }
  keepTokenFresh(data.session);
  return { ok: true };
}

export async function switchAccount(id: string): Promise<ActionResult> {
  if (store.get().activeId === id) return { ok: true };
  if (store.get().busy) return fail("Please wait a moment.");
  patch({ busy: true, notice: null });
  try {
    return await switchInner(id);
  } catch (error) {
    return fail(describeError(error));
  } finally {
    patch({ busy: false });
  }
}

// Signs the ACTIVE account out of this device, frees its slot, and switches to another saved account
export async function signOutActive(): Promise<ActionResult> {
  const client = supabase;
  const id = store.get().activeId;
  if (!client || id === null) return { ok: true };
  if (store.get().busy) return fail("Please wait a moment.");

  patch({ busy: true, notice: null });
  try {
    await callRpc("release_device_slot", { p_device_id: getDeviceId() }); // best effort

    expectedSignOut = true;
    let error: unknown = null;
    try {
      const result = await client.auth.signOut({ scope: "local" });
      error = result.error;
    } finally {
      expectedSignOut = false;
    }
    if (error) return fail(describeError(error));

    mutateSaved((list) => list.filter((a) => a.userId !== id));
    const next = loadSaved().find((a) => !a.needsSignIn && a.refreshToken !== "");
    if (next) await switchInner(next.userId);
    return { ok: true };
  } catch (error) {
    return fail(describeError(error));
  } finally {
    patch({ busy: false });
  }
}

export async function setAvatar(avatarId: string): Promise<ActionResult> {
  const client = supabase;
  const id = store.get().activeId;
  if (!client || id === null) return fail("Sign in first.");
  if (!isAvatarId(avatarId)) return fail("Unknown profile picture.");

  try {
    const result = await client
      .from("profiles")
      .update({ avatar_id: avatarId })
      .eq("id", id)
      .select("id, username, avatar_id")
      .maybeSingle();
    if (result.error) return fail(describeError(result.error));
    const profile = parseProfile(result.data);
    if (!profile) return fail("Couldn't save the picture.");

    if (store.get().activeId === id) patch({ profile });
    mutateSaved((list) => list.map((a) => (a.userId === id ? { ...a, avatarId: profile.avatarId } : a)));
    return { ok: true };
  } catch (error) {
    return fail(describeError(error));
  }
}

export async function setLocationSharing(enabled: boolean): Promise<ActionResult> {
  const client = supabase;
  const id = store.get().activeId;
  if (!client || id === null) return fail("Sign in first.");

  try {
    const result = await client
      .from("profiles")
      .update({ share_location: enabled })
      .eq("id", id)
      .select("id, username, avatar_id, share_location")
      .maybeSingle();
    if (result.error) {
      if (isMissingProfileColumnError(result.error)) {
        return fail(
          "Location sharing isn't enabled in this Supabase schema yet. Run the migration in supabase/01_location_sharing.sql."
        );
      }
      return fail(describeError(result.error));
    }
    const profile = parseProfile(result.data);
    if (!profile) return fail("Couldn't save the privacy setting.");

    if (store.get().activeId === id) patch({ profile });
    return { ok: true };
  } catch (error) {
    return fail(describeError(error));
  }
}

export function dismissNotice() {
  patch({ notice: null });
}