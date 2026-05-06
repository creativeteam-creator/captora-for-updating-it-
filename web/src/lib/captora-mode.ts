/**
 * Runtime mode detection — single source of truth for "are we running
 * inside the Electron desktop wrapper, or as a normal Next.js web app?".
 *
 * Set by the Electron main process BEFORE spawning the Next.js standalone
 * server (see `electron/src/nextServer.ts`). When unset, behaviour falls
 * back to the existing web-mode path so a VPS deploy is unaffected.
 *
 * The split lets `/api/transcribe` and `/api/render` do the right thing
 * for each environment without forking the codebase:
 *
 *   - Web mode: source video lives in Supabase Storage; render output
 *     gets uploaded back to Supabase; everything is cloud-first.
 *   - Desktop mode: source video stays in the user's local temp folder
 *     (auto-cleaned after 12h); render output writes to the user's local
 *     renders folder; cloud usage drops to just Auth + project metadata.
 *
 * Three env vars drive this:
 *   CAPTORA_MODE             "desktop" | (anything else)
 *   CAPTORA_SESSIONS_DIR     absolute path to the temp folder (desktop only)
 *   CAPTORA_RENDERS_DIR      absolute path to the renders folder (desktop only)
 */

export type CaptoraMode = "web" | "desktop";

export function getMode(): CaptoraMode {
  return process.env.CAPTORA_MODE === "desktop" ? "desktop" : "web";
}

export function isDesktopMode(): boolean {
  return getMode() === "desktop";
}

export function isWebMode(): boolean {
  return getMode() === "web";
}

/** Local sessions (temp) folder — only valid when `isDesktopMode()`. */
export function getLocalSessionsDir(): string {
  return process.env.CAPTORA_SESSIONS_DIR ?? "";
}

/** Local renders folder — only valid when `isDesktopMode()`. */
export function getLocalRendersDir(): string {
  return process.env.CAPTORA_RENDERS_DIR ?? "";
}
