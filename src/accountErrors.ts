import { isRecord } from "./dbParse";

export const LIMIT_MESSAGE = "This device already has 3 accounts. Sign out of one first.";

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "";
}

export function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "";
}

// True when the request never reached the server (offline, blocked, server down)
export function isNetworkError(error: unknown): boolean {
  const name = isRecord(error) && typeof error.name === "string" ? error.name : "";
  return (
    name === "AuthRetryableFetchError" ||
    /failed to fetch|networkerror|network request failed|load failed/i.test(errorMessage(error))
  );
}

// The database functions raise short codes such as 'user_not_found'. This turns them into sentences.
const DATABASE_CODES: [string, string][] = [
  ["not_signed_in", "You're signed out. Sign in again."],
  ["user_not_found", "No user with that username."],
  ["self_request", "You can't add yourself."],
  ["already_friends", "You're already friends."],
  ["request_exists", "A friend request is already pending."],
  ["request_blocked", "You can't send a request to this user right now."],
  ["request_not_found", "That request no longer exists."],
  ["device_limit", LIMIT_MESSAGE],
  ["favourite_limit", "You've reached the limit of 50 favourite routes."],
];

export function describeError(error: unknown): string {
  const message = errorMessage(error);
  const code = errorCode(error);
  const text = message.toLowerCase();

  for (const [key, sentence] of DATABASE_CODES) {
    if (text.includes(key)) return sentence;
  }
  if (
    code === "PGRST301" ||
    /jwt expired|invalid jwt|refresh_token_not_found|session_not_found|session_expired/.test(
      `${text} ${code.toLowerCase()}`
    )
  ) {
    return "Your session expired. Sign in again.";
  }
  if (isNetworkError(error)) return "Can't reach Veode's server. Check your connection.";
  if (code === "42501") return "That isn't allowed for this account.";
  return message || "Something went wrong. Try again.";
}

// For sign-up and sign-in errors
export function describeAuthError(error: unknown): string {
  const code = errorCode(error);
  const message = errorMessage(error);

  if (code === "invalid_credentials" || /invalid login credentials/i.test(message)) {
    return "Wrong username or password.";
  }
  if (code === "user_already_exists" || /already registered/i.test(message)) {
    return "That username is taken.";
  }
  if (code === "email_address_invalid" || /email address .* is invalid/i.test(message)) {
    return "Supabase rejected the hidden login email. Change VITE_AUTH_EMAIL_TEMPLATE to a domain that exists.";
  }
  if (code === "weak_password") return "That password is too weak. Try a longer one.";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit") {
    return "Too many attempts. Wait a few minutes and try again.";
  }
  if (code === "signup_disabled") return "Sign-ups are turned off in your Supabase project.";
  if (code === "email_not_confirmed") {
    return "Turn off “Confirm email” in Supabase (Authentication → Providers → Email).";
  }
  if (/database error saving new user/i.test(message)) {
    return "That username is taken or not allowed.";
  }
  return describeError(error);
}