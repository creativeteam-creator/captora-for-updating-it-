/**
 * Validation for the two client-supplied values that get concatenated
 * into filesystem paths: `projectId` and `ext`.
 *
 * Both /api/transcribe and /api/render build working paths as
 * `join(sessionDir(), `${projectId}${ext}`)`, and /api/render also stages
 * the source into the Remotion bundle as
 * `render-${projectId}-${uuid}${ext}`. Neither value was checked beyond
 * `ext.startsWith(".")` — which "../../evil" satisfies, because it does
 * start with a dot. Either field could therefore walk the path out of its
 * intended directory.
 *
 * These helpers are allow-list based on purpose. A blocklist of "..", "/"
 * and "\" would cover the cases we thought of; an allow-list covers the
 * ones we didn't, including URL-encoded and unicode variants, NUL bytes,
 * and Windows alternate data streams.
 */

/** Canonical UUID v1–v5 shape, which is what `crypto.randomUUID()` and
 *  Postgres `gen_random_uuid()` both produce. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Media extensions Captora accepts, matching the native file picker's
 * filter in electron/src/main.ts plus the audio formats the transcribe
 * pipeline recognises. Lowercase, leading dot.
 */
export const ALLOWED_MEDIA_EXTS = new Set([
  // video
  ".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".3gp",
  // audio
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".wma",
]);

/**
 * True when `id` is a well-formed UUID and therefore safe to embed in a
 * filename. Rejects anything containing a separator or traversal segment
 * by construction — a UUID has no room for them.
 */
export function isValidProjectId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

/**
 * Normalise and validate a media file extension.
 *
 * Returns the lowercase, dot-prefixed extension when it's one Captora
 * supports, or `null` when it isn't. Callers must treat `null` as a 400 —
 * never as "fall back to .mp3", which would silently write the file under
 * a name that doesn't match its contents.
 */
export function safeMediaExt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  return ALLOWED_MEDIA_EXTS.has(withDot) ? withDot : null;
}
