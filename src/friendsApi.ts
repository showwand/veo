import { callRpc } from "./supabaseClient";
import { describeError } from "./accountErrors";
import { asString, parseList, type ApiResult } from "./dbParse";
import { DEFAULT_AVATAR_ID, isAvatarId } from "./avatars";

// Everything about friends goes through database functions (see the migration), so the browser
// never reads other people's profiles directly and only ever sees: id, username, avatar.

export type Relation = "none" | "friends" | "outgoing" | "incoming" | "self";
export type FoundProfile = { id: string; username: string; avatarId: string; relation: Relation };
export type Friend = { id: string; username: string; avatarId: string };
export type FriendRequest = {
  requestId: string;
  direction: "incoming" | "outgoing";
  userId: string;
  username: string;
  avatarId: string;
};

function avatarOf(value: unknown): string {
  const id = asString(value);
  return id !== null && isAvatarId(id) ? id : DEFAULT_AVATAR_ID;
}

function toRelation(value: string): Relation {
  switch (value) {
    case "friends":
    case "outgoing":
    case "incoming":
    case "self":
      return value;
    default:
      return "none";
  }
}

export async function findProfile(username: string): Promise<ApiResult<FoundProfile | null>> {
  try {
    const { data, error } = await callRpc("find_profile", { p_username: username });
    if (error) return { ok: false, message: describeError(error) };
    const rows = parseList<FoundProfile>(data, (row) => {
      const id = asString(row.id);
      const name = asString(row.username);
      const relation = asString(row.relation);
      if (id === null || name === null || relation === null) return null;
      return { id, username: name, avatarId: avatarOf(row.avatar_id), relation: toRelation(relation) };
    });
    return { ok: true, data: rows[0] ?? null };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

// "sent" = request created. "accepted" = they had already asked you, so you are now friends.
export async function sendFriendRequest(username: string): Promise<ApiResult<"sent" | "accepted">> {
  try {
    const { data, error } = await callRpc("send_friend_request", { p_username: username });
    if (error) return { ok: false, message: describeError(error) };
    return { ok: true, data: data === "accepted" ? "accepted" : "sent" };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function respondToRequest(requestId: string, accept: boolean): Promise<ApiResult<null>> {
  try {
    const { error } = await callRpc("respond_to_friend_request", {
      p_request_id: requestId,
      p_accept: accept,
    });
    if (error) return { ok: false, message: describeError(error) };
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function removeFriend(friendId: string): Promise<ApiResult<null>> {
  try {
    const { error } = await callRpc("remove_friend", { p_friend_id: friendId });
    if (error) return { ok: false, message: describeError(error) };
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function listFriends(): Promise<ApiResult<Friend[]>> {
  try {
    const { data, error } = await callRpc("my_friends");
    if (error) return { ok: false, message: describeError(error) };
    const friends = parseList<Friend>(data, (row) => {
      const id = asString(row.id);
      const username = asString(row.username);
      if (id === null || username === null) return null;
      return { id, username, avatarId: avatarOf(row.avatar_id) };
    });
    return { ok: true, data: friends };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function listRequests(): Promise<ApiResult<FriendRequest[]>> {
  try {
    const { data, error } = await callRpc("my_friend_requests");
    if (error) return { ok: false, message: describeError(error) };
    const requests = parseList<FriendRequest>(data, (row) => {
      const requestId = asString(row.request_id);
      const userId = asString(row.other_id);
      const username = asString(row.username);
      const direction = asString(row.direction);
      if (requestId === null || userId === null || username === null) return null;
      if (direction !== "incoming" && direction !== "outgoing") return null;
      return { requestId, direction, userId, username, avatarId: avatarOf(row.avatar_id) };
    });
    return { ok: true, data: requests };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}