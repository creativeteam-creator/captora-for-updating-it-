/**
 * Per-user API key overrides for cloud LLM providers.
 *
 * Backed by `public.user_api_keys` (see migrations/006_user_api_keys.sql).
 * Each Captora user can plug in their own Gemini and/or Groq API key from
 * the Settings panel. When set, the transcribe pipeline uses the user's
 * key instead of the bundled production key — giving the team per-user
 * quota isolation so one heavy uploader can't lock everyone out of the
 * Hinglish polish step.
 *
 * Fall-through rules (resolved at /api/transcribe entry):
 *   user gemini key set?  → use it
 *   else                  → fall back to process.env.GEMINI_API_KEY
 *   (same for Groq)
 *
 * Keys are stored in plaintext at rest under RLS — only the owning user
 * (and the Supabase service role used by Captora's own server) can read
 * them. A future migration can move to encrypted storage if needed; for
 * a team of ~10 trusted clinic users on a private database, plaintext +
 * RLS is the right complexity trade-off.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface UserApiKeys {
  geminiApiKey: string | null;
  groqApiKey: string | null;
  updatedAt: string | null;
}

const TABLE = "user_api_keys";

interface Row {
  user_id: string;
  gemini_api_key: string | null;
  groq_api_key: string | null;
  updated_at: string;
}

/**
 * Read the signed-in user's stored API keys. Returns null fields when
 * no row exists yet (first visit to the Settings panel). The Supabase
 * client must already be authenticated — caller decides whether to use
 * the browser client or the server-side `createClient()`.
 */
export async function getUserApiKeys(
  // Using `any` rather than the strict SupabaseClient generic because our
  // `Database` type isn't generated; the runtime contract is what matters.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string
): Promise<UserApiKeys> {
  const { data, error } = (await supabase
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .maybeSingle()) as { data: Row | null; error: { message: string } | null };

  if (error) {
    console.warn("[userApiKeys] read failed:", error.message);
    return { geminiApiKey: null, groqApiKey: null, updatedAt: null };
  }
  if (!data) {
    return { geminiApiKey: null, groqApiKey: null, updatedAt: null };
  }
  return {
    geminiApiKey: data.gemini_api_key,
    groqApiKey: data.groq_api_key,
    updatedAt: data.updated_at,
  };
}

/**
 * Upsert the user's API keys. Pass `null` for a field to clear it (so the
 * pipeline falls back to the bundled key). Returns the freshly saved row.
 */
export async function saveUserApiKeys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  keys: { geminiApiKey?: string | null; groqApiKey?: string | null }
): Promise<UserApiKeys> {
  const patch: Partial<Row> & { user_id: string } = {
    user_id: userId,
    updated_at: new Date().toISOString(),
  };
  if (keys.geminiApiKey !== undefined) {
    patch.gemini_api_key = sanitiseKey(keys.geminiApiKey);
  }
  if (keys.groqApiKey !== undefined) {
    patch.groq_api_key = sanitiseKey(keys.groqApiKey);
  }
  const { data, error } = (await supabase
    .from(TABLE)
    .upsert(patch, { onConflict: "user_id" })
    .select()
    .single()) as { data: Row | null; error: { message: string } | null };
  if (error || !data) {
    throw new Error(`saveUserApiKeys: ${error?.message ?? "unknown error"}`);
  }
  return {
    geminiApiKey: data.gemini_api_key,
    groqApiKey: data.groq_api_key,
    updatedAt: data.updated_at,
  };
}

/**
 * Server-side: resolve which key to use for a given provider.
 * Caller passes the user's stored key (possibly null) and the env default
 * to use as fallback. Returns the chosen key + whether it's user-owned
 * (the `userOwned` flag drives the "your key" wording in 429 messages).
 */
export function resolveProviderKey(
  userKey: string | null,
  envDefault: string | undefined
): { key: string | undefined; userOwned: boolean } {
  if (userKey && userKey.trim().length > 0) {
    return { key: userKey.trim(), userOwned: true };
  }
  return { key: envDefault, userOwned: false };
}

/**
 * Trim whitespace + reject obvious garbage. Empty strings collapse to
 * null so the row clears the override.
 */
function sanitiseKey(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Discourage accidental pasting of "Bearer xyz" or quoted strings.
  const cleaned = trimmed.replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "");
  return cleaned.length > 0 ? cleaned : null;
}
