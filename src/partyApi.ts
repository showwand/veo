import { callRpc } from "./supabaseClient";
import { describeError, errorMessage } from "./accountErrors";
import { asString, parseList, type ApiResult } from "./dbParse";

export type PartyEntry = {
  partyId: string;
  ownerId: string;
  ownerUsername: string;
  ownerAvatarId: string;
  memberId: string;
  memberUsername: string;
  memberAvatarId: string;
  status: "pending" | "accepted";
  direction: "outgoing" | "member" | "incoming";
};

function parsePartyEntry(row: Record<string, unknown>): PartyEntry | null {
  const partyId = asString(row.party_id);
  const ownerId = asString(row.owner_id);
  const ownerUsername = asString(row.owner_username);
  const memberId = asString(row.member_id);
  const memberUsername = asString(row.member_username);
  const status = asString(row.status);
  const direction = asString(row.direction);
  if (
    partyId === null ||
    ownerId === null ||
    ownerUsername === null ||
    memberId === null ||
    memberUsername === null ||
    (status !== "pending" && status !== "accepted") ||
    (direction !== "outgoing" && direction !== "member" && direction !== "incoming")
  ) {
    return null;
  }

  return {
    partyId,
    ownerId,
    ownerUsername,
    ownerAvatarId: asString(row.owner_avatar_id) ?? "avatar_01",
    memberId,
    memberUsername,
    memberAvatarId: asString(row.member_avatar_id) ?? "avatar_01",
    status,
    direction,
  };
}

export async function listMyParty(): Promise<ApiResult<PartyEntry[]>> {
  try {
    const { data, error } = await callRpc("my_party");
    if (error) return { ok: false, message: describeError(error) };
    return { ok: true, data: parseList(data, parsePartyEntry) };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function inviteFriendToParty(friendId: string): Promise<ApiResult<null>> {
  try {
    const { error } = await callRpc("invite_friend_to_party", { p_friend_id: friendId });
    if (error) {
      if (errorMessage(error).includes("not_friends")) {
        return { ok: false, message: "Party invites are only available for accepted friends." };
      }
      return { ok: false, message: describeError(error) };
    }
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function respondToPartyInvite(
  partyId: string,
  accept: boolean
): Promise<ApiResult<null>> {
  try {
    const { error } = await callRpc("respond_to_party_invite", {
      p_party_id: partyId,
      p_accept: accept,
    });
    if (error) return { ok: false, message: describeError(error) };
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function leaveParty(partyId: string): Promise<ApiResult<null>> {
  try {
    const { error } = await callRpc("leave_party", { p_party_id: partyId });
    if (error) return { ok: false, message: describeError(error) };
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}
