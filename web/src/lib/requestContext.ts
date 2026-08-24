/**
 * Per-request context for /api/transcribe.
 *
 * We use Node's AsyncLocalStorage so anything called inside the transcribe
 * handler — provider pickers, LLM batches, glossary lookup, safety net —
 * can read the signed-in user's overrides without us having to thread the
 * data through every function signature.
 *
 * Currently carries:
 *   - keyOverrides: user-supplied Gemini / Groq API keys (Settings panel)
 *   - userGlossary: the user's own caption corrections (captions list)
 *
 * If the field is null/empty, callers fall back to the bundled key from
 * process.env (the production .env.production written by GitHub Actions).
 */

import { AsyncLocalStorage } from "async_hooks";

export interface RequestKeyOverrides {
  geminiApiKey: string | null;
  groqApiKey: string | null;
}

/** Warnings surface back to the route handler so the API response can
 *  include a structured note for the UI (e.g. "your Gemini key hit its
 *  daily quota"). Downstream LLM code pushes; the route handler reads
 *  after the transcribe() call returns. */
export interface RequestWarning {
  kind: "quota-exhausted" | "all-llm-failed";
  provider: "gemini" | "groq" | "elevenlabs" | "all";
  /** True when the failing key was the user's own (Settings panel) and
   *  false when it was the bundled shared key. Drives the wording on
   *  the UI banner: "aapki Groq key ki quota khatam hui" vs "shared key
   *  exhausted — please add your own from Settings". */
  userOwned: boolean;
  message: string;
}

export interface RequestCtx {
  keyOverrides: RequestKeyOverrides;
  warnings: RequestWarning[];
  /**
   * The signed-in user's own caption corrections, lowercased key →
   * replacement (see lib/userGlossary.ts). Rides the context for the
   * same reason the keys do: the glossary is applied deep inside the
   * transliteration code, several calls below the route that knows who
   * the user is.
   *
   * Optional so existing callers that build a context without it still
   * type-check; readers treat `undefined` as "no user corrections".
   */
  userGlossary?: Record<string, string>;
}

const storage = new AsyncLocalStorage<RequestCtx>();

/** Run `fn` with the given request context attached. Use at the start of
 *  an API route to bind the resolved per-user keys for the rest of the
 *  call tree. */
export function withRequestContext<T>(ctx: RequestCtx, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run(ctx, fn);
}

/** Read the current request's context. Returns `undefined` outside of a
 *  `withRequestContext` block — callers should fall back to process.env. */
export function getRequestContext(): RequestCtx | undefined {
  return storage.getStore();
}

/** Convenience: read the per-user override for a single provider key,
 *  falling back to `envDefault` when the user hasn't set one. Returns
 *  `{key, userOwned}` so callers can attribute quota errors back to the
 *  right person ("aapki key" vs "shared bundled key"). */
export function resolveKey(
  provider: "gemini" | "groq",
  envDefault: string | undefined
): { key: string | undefined; userOwned: boolean } {
  const ctx = getRequestContext();
  const userKey =
    provider === "gemini"
      ? ctx?.keyOverrides.geminiApiKey
      : ctx?.keyOverrides.groqApiKey;
  if (userKey && userKey.trim().length > 0) {
    return { key: userKey.trim(), userOwned: true };
  }
  return { key: envDefault, userOwned: false };
}

/** Read the active request's user glossary. Returns `{}` outside a
 *  request context and for users who've never corrected a word, so
 *  callers can merge it unconditionally. */
export function resolveUserGlossary(): Record<string, string> {
  return getRequestContext()?.userGlossary ?? {};
}

/** Append a warning to the active request. No-op outside a request
 *  context (e.g. unit tests, scripts). */
export function pushWarning(warning: RequestWarning): void {
  const ctx = getRequestContext();
  if (!ctx) return;
  ctx.warnings.push(warning);
}
