import { callRpc } from "./supabaseClient";
import { describeError } from "./accountErrors";
import { asString, parseList, type ApiResult } from "./dbParse";

export type FriendMessage = {
  id: string;
  senderId: string;
  recipientId: string;
  body: string;
  createdAt: string;
};

function parseMessage(row: Record<string, unknown>): FriendMessage | null {
  const id = asString(row.id);
  const senderId = asString(row.sender_id);
  const recipientId = asString(row.recipient_id);
  const body = asString(row.body);
  const createdAt = asString(row.created_at);
  if (id === null || senderId === null || recipientId === null || body === null || createdAt === null) {
    return null;
  }
  return { id, senderId, recipientId, body, createdAt };
}

export async function listFriendMessages(friendId: string): Promise<ApiResult<FriendMessage[]>> {
  try {
    const { data, error } = await callRpc("list_friend_messages", {
      p_friend_id: friendId,
      p_limit: 100,
    });
    if (error) return { ok: false, message: describeError(error) };
    return { ok: true, data: parseList(data, parseMessage) };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function sendFriendMessage(
  friendId: string,
  body: string
): Promise<ApiResult<FriendMessage>> {
  const text = body.trim();
  if (!text || text.length > 2000) {
    return { ok: false, message: "Messages must be between 1 and 2,000 characters." };
  }

  try {
    const { data, error } = await callRpc("send_friend_message", {
      p_friend_id: friendId,
      p_body: text,
    });
    if (error) return { ok: false, message: describeError(error) };
    const message = parseList(data, parseMessage)[0];
    if (!message) {
      return { ok: false, message: "The message could not be confirmed by the server." };
    }
    return { ok: true, data: message };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}
