import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isRecord } from "./dbParse";

// Only the project URL and the PUBLISHABLE key belong in the browser. Row Level Security in
// the database is what protects the data. The secret / service_role key must never be here.
const url: unknown = import.meta.env.VITE_SUPABASE_URL;
const publishableKey: unknown = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const emailTemplate: unknown = import.meta.env.VITE_AUTH_EMAIL_TEMPLATE;

// Refuses to start if a secret key was pasted in by mistake
function isSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return false;
  try {
    const json: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return isRecord(json) && json.role === "service_role";
  } catch {
    return false;
  }
}

function makeClient(): SupabaseClient | null {
  if (typeof url !== "string" || url === "") return null;
  if (typeof publishableKey !== "string" || publishableKey === "") return null;
  if (isSecretKey(publishableKey)) {
    console.error(
      "Veode: VITE_SUPABASE_PUBLISHABLE_KEY looks like a SECRET key. Remove it and use the publishable key."
    );
    return null;
  }
  return createClient(url, publishableKey, {
    auth: {
      persistSession: true, // Supabase keeps the ACTIVE account signed in across refreshes
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: "veode-auth",
    },
  });
}

// null = Supabase isn't configured (the rest of the app still works)
export const supabase: SupabaseClient | null = makeClient();

// "{u}@your-domain.com" + "showwand" -> "showwand@your-domain.com". Null if not configured.
export function emailForUsername(username: string): string | null {
  if (typeof emailTemplate !== "string") return null;
  if (!emailTemplate.includes("{u}") || !emailTemplate.includes("@")) return null;
  return emailTemplate.replace("{u}", username);
}

// Calls a database function and returns plain `unknown` data, so callers must check what they got
export async function callRpc(
  name: string,
  args?: Record<string, unknown>
): Promise<{ data: unknown; error: unknown }> {
  if (!supabase) return { data: null, error: new Error("Supabase isn't set up yet.") };
  const result = await supabase.rpc(name, args);
  const data: unknown = result.data;
  const error: unknown = result.error;
  return { data, error };
}