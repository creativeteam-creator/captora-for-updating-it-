/**
 * Project storage backed by Supabase. The previous localStorage version
 * shipped while we were building the UI in isolation — now persistence
 * runs through the `projects` table + storage buckets defined in
 * `supabase/migrations/001_init.sql`.
 *
 * All read paths go through the browser client (RLS-scoped), so each
 * user only ever sees their own projects. Writes that need uploaded
 * media first hit `/api/transcribe`, which inserts the row server-side
 * with the user's session.
 */

"use client";

import { createClient } from "./supabase/client";
import {
  RENDERS_BUCKET,
  RENDER_EXTS,
  SOURCE_BUCKET,
  THUMBNAILS_BUCKET,
  signedUrl,
} from "./supabase/storage";
import type { Database } from "./supabase/types";
import type { CaptionStyleId, CaptionStyleOverrides } from "./styles";
import type { WhisperResult } from "./whisper";
import type { TranscribeProvider } from "./transcribe";
import { isElectron } from "./electron-bridge";

type ProjectRow = Database["public"]["Tables"]["projects"]["Row"];

/**
 * Client-facing shape. Composed from the DB row plus signed URLs for
 * media (thumbnails / source / rendered MP4) so components don't deal
 * with bucket paths directly.
 */
export interface ProjectRecord {
  id: string;
  userId: string;
  title: string;
  createdAt: number;                 // ms — converted from ISO at fetch
  updatedAt: number;
  /** Optimistic-concurrency token (see migrations/010_project_version.sql).
   *  `null` when the migration hasn't been applied yet — updateProject()
   *  falls back to its old unconditional-write behaviour in that case. */
  version: number | null;

  // Source media
  sourcePath: string | null;         // bucket path, e.g. "<uid>/<id>.mp3"
  sourceUrl: string | null;          // signed URL for download
  ext: string;                       // ".mp3", ".mp4", …
  thumbnail: string | null;          // signed URL (or null)
  mediaKind: "video" | "audio";

  // Language settings
  spokenLanguage: string;
  spokenLanguageLabel: string;
  writingScript: "native" | "roman";
  writingScriptLabel: string;
  translateToEnglish: boolean;

  // Transcription
  provider?: TranscribeProvider;
  whisper: WhisperResult;

  // Style
  styleId: CaptionStyleId;
  styleOverrides: CaptionStyleOverrides;
  /** Per-line entrance-animation overrides (centisecond key → variant
   *  name). Persisted in `projects.line_animations`. */
  lineAnimations: Record<string, string>;
  /** Per-line template overrides (centisecond key → CaptionStyleId).
   *  Persisted in `projects.line_styles` (migration 008). */
  lineStyles: Record<string, CaptionStyleId>;
  /** Per-word size multipliers (centisecond key → multiplier).
   *  Persisted in `projects.word_sizes` (migration 008). */
  wordSizes: Record<string, number>;
  /** Word indexes after which the grouper forces a new line. Stored as
   *  an array because the editor holds a Set, which isn't
   *  JSON-serialisable. Persisted in `projects.user_breaks`. */
  userBreaks: number[];

  // Render
  renderStatus: "idle" | "rendering" | "rendered" | "failed";
  renderUrl: string | null;          // signed URL for the rendered MP4
  renderedAt: number | null;
}

// ───────────────────────── public API ─────────────────────────

export async function listProjects(): Promise<ProjectRecord[]> {
  const supabase = createClient();
  // Cast — @supabase/ssr's typed client doesn't satisfy the older
  // SupabaseClient<Database, "public", Database["public"]> shape that our
  // helpers expect. Schema is correct at runtime; cast keeps TS quiet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  // Explicit limit, well above any realistic near-term project count for
  // a small clinic team — PostgREST's own default max-rows cap (1000)
  // otherwise truncates silently with no error and no indication
  // anything was cut off, and since results are newest-first, it's the
  // OLDEST projects that would quietly disappear first.
  const LIST_PROJECTS_LIMIT = 2000;
  const { data, error } = await sb
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(LIST_PROJECTS_LIMIT);
  if (!error && Array.isArray(data) && data.length === LIST_PROJECTS_LIMIT) {
    console.warn(
      `[projects] listProjects() hit its ${LIST_PROJECTS_LIMIT}-row limit — older projects may be missing from this list.`
    );
  }
  if (error) {
    console.warn("[projects] list failed:", error.message);
    return [];
  }
  return Promise.all((data as ProjectRow[]).map((row) => rowToRecord(sb, row)));
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { data, error } = await sb
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return rowToRecord(sb, data as ProjectRow);
}

/**
 * Patch a project row (style edits, title, etc.). The /api/transcribe
 * route owns INSERTs because they need server-side validation + storage
 * uploads — clients only update existing rows.
 */
export interface UpdateProjectResult {
  /** New version after a successful write, or the unchanged version on
   *  a conflict. `null` when the version column isn't available yet
   *  (migration 010 not applied) — caller just keeps going unprotected,
   *  same as before this fix existed. */
  version: number | null;
  /** True when `expectedVersion` was passed and didn't match the row's
   *  current version — someone else's write landed first and this
   *  patch was NOT applied, to avoid silently overwriting it. */
  conflict: boolean;
}

/**
 * Patch a project row (style edits, title, etc.). The /api/transcribe
 * route owns INSERTs because they need server-side validation + storage
 * uploads — clients only update existing rows.
 *
 * `expectedVersion`, when provided, makes the write conditional: it only
 * applies if the row's `version` still matches what the caller last saw.
 * Several of these fields (line_animations, line_styles, word_sizes,
 * userBreaks) are FULL-REPLACE, not merged — the same project open in a
 * second tab/device holding a stale in-memory snapshot would otherwise
 * silently clobber whatever the first tab just saved. Pass it when you
 * have one; omit it for call sites that don't track a version (keeps
 * the old unconditional behaviour).
 */
export async function updateProject(
  id: string,
  patch: {
    title?: string;
    styleId?: CaptionStyleId;
    styleOverrides?: CaptionStyleOverrides;
    /** Edited word list — overwrites `transcript_words` entirely. */
    whisperWords?: Array<{ word: string; start: number; end: number }>;
    /** Recomputed full-text caption from edited words (for downstream consumers). */
    transcriptText?: string;
    /** Per-line animation overrides — replaces the existing map entirely. */
    lineAnimations?: Record<string, string>;
    /** Per-line template picks — replaces the existing map entirely. */
    lineStyles?: Record<string, CaptionStyleId>;
    /** Per-word size multipliers — replaces the existing map entirely. */
    wordSizes?: Record<string, number>;
    /** Forced line-break word indexes — replaces the existing list. */
    userBreaks?: number[];
  },
  expectedVersion?: number
): Promise<UpdateProjectResult> {
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const dbPatch: Record<string, unknown> = {};
  if (patch.title !== undefined) dbPatch.title = patch.title;
  if (patch.styleId !== undefined) dbPatch.style_id = patch.styleId;
  if (patch.styleOverrides !== undefined) dbPatch.style_overrides = patch.styleOverrides;
  if (patch.whisperWords !== undefined) dbPatch.transcript_words = patch.whisperWords;
  if (patch.transcriptText !== undefined) dbPatch.transcript_text = patch.transcriptText;
  if (patch.lineAnimations !== undefined) dbPatch.line_animations = patch.lineAnimations;
  if (patch.lineStyles !== undefined) dbPatch.line_styles = patch.lineStyles;
  if (patch.wordSizes !== undefined) dbPatch.word_sizes = patch.wordSizes;
  if (patch.userBreaks !== undefined) dbPatch.user_breaks = patch.userBreaks;
  if (Object.keys(dbPatch).length === 0) return { version: expectedVersion ?? null, conflict: false };

  if (typeof expectedVersion === "number") {
    const { data, error } = await sb
      .from("projects")
      .update({ ...dbPatch, version: expectedVersion + 1 })
      .eq("id", id)
      .eq("version", expectedVersion)
      .select("version")
      .maybeSingle();
    if (error) {
      // `version` column doesn't exist yet — migration 010 hasn't been
      // run. Fall back to the pre-existing unconditional write rather
      // than breaking every save until it is.
      if (/column .*version.* does not exist/i.test(error.message)) {
        const { error: fallbackErr } = await sb.from("projects").update(dbPatch).eq("id", id);
        if (fallbackErr) throw new Error(`updateProject: ${fallbackErr.message}`);
        return { version: null, conflict: false };
      }
      throw new Error(`updateProject: ${error.message}`);
    }
    if (!data) {
      // No row matched (id + version) — another session's write already
      // bumped the version since we last read it. Don't apply this
      // patch on top of data we haven't seen.
      return { version: expectedVersion, conflict: true };
    }
    return { version: (data as { version: number }).version, conflict: false };
  }

  const { error } = await sb.from("projects").update(dbPatch).eq("id", id);
  if (error) throw new Error(`updateProject: ${error.message}`);
  return { version: null, conflict: false };
}

export async function deleteProject(id: string): Promise<void> {
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;

  // Read first so we know which storage objects to clean up. RLS already
  // restricts to the user's own row, so this can't leak others' data.
  const { data: row } = await sb
    .from("projects")
    .select("source_path, source_thumbnail, render_url, user_id")
    .eq("id", id)
    .maybeSingle();

  // Delete the DB row first (RLS-scoped). On error we leave storage
  // alone — orphans are recoverable, broken state is worse.
  const { error } = await sb.from("projects").delete().eq("id", id);
  if (error) throw new Error(`deleteProject: ${error.message}`);

  // Best-effort storage cleanup — fire-and-forget.
  if (row) {
    const r = row as {
      source_path: string | null;
      source_thumbnail: string | null;
      user_id: string | null;
    };
    if (r.source_path) {
      sb.storage.from(SOURCE_BUCKET).remove([r.source_path]).catch(() => {});
    }
    if (r.source_thumbnail && !r.source_thumbnail.startsWith("data:")) {
      sb.storage.from(THUMBNAILS_BUCKET).remove([r.source_thumbnail]).catch(() => {});
    }
    // Renders are keyed by `<uid>/<projectId><ext>`. Remove every
    // container we can produce rather than assuming .mp4 — a transparent
    // export is a .mov, and guessing wrong leaves the file orphaned in
    // the bucket forever, still counting against storage quota. Removing
    // a key that doesn't exist is a no-op.
    if (r.user_id) {
      sb.storage
        .from(RENDERS_BUCKET)
        .remove(RENDER_EXTS.map((e) => `${r.user_id}/${id}${e}`))
        .catch(() => {});
    }
  }
}

// ───────────────────────── helpers ─────────────────────────

const AUDIO_EXTS = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".wma",
]);

export function detectMediaKind(ext: string): "video" | "audio" {
  return AUDIO_EXTS.has(ext.toLowerCase()) ? "audio" : "video";
}

/**
 * Generate a small JPEG thumbnail from the first half-second of a video,
 * encoded as a data URL. Reused from the localStorage era — kept
 * client-side because grabbing a frame requires the actual File blob,
 * which the browser already has.
 *
 * Returns `undefined` for audio uploads (no frame to grab).
 */
export async function generateThumbnail(
  file: File,
  mediaKind: "video" | "audio"
): Promise<string | undefined> {
  if (mediaKind === "audio") return undefined;

  return new Promise<string | undefined>((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.remove();
    };

    video.addEventListener("loadeddata", () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 4);
    });

    video.addEventListener("seeked", () => {
      const canvas = document.createElement("canvas");
      const targetW = 240;
      const targetH = 320;
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        cleanup();
        return resolve(undefined);
      }
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const targetAspect = targetW / targetH;
      const videoAspect = vw / vh;
      let sx = 0, sy = 0, sw = vw, sh = vh;
      if (videoAspect > targetAspect) {
        sw = vh * targetAspect;
        sx = (vw - sw) / 2;
      } else {
        sh = vw / targetAspect;
        sy = (vh - sh) / 2;
      }
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH);
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch {
        resolve(undefined);
      } finally {
        cleanup();
      }
    });

    video.addEventListener("error", () => {
      cleanup();
      resolve(undefined);
    });
  });
}

export function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "Just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr${hr > 1 ? "s" : ""} ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "Yesterday";
  if (day < 7) return `${day} days ago`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week} week${week > 1 ? "s" : ""} ago`;
  const month = Math.floor(day / 30);
  return `${month} month${month > 1 ? "s" : ""} ago`;
}

// ───────────────────────── row → record ─────────────────────────

// `any` here matches the `sb` casts at the call sites — see the comment
// in listProjects() about @supabase/ssr generic mismatch. Storage helpers
// only need `.storage.from(...)` which works identically across types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rowToRecord(
  supabase: any,
  row: ProjectRow
): Promise<ProjectRecord> {
  // Resolve storage paths to time-limited signed URLs. Thumbnails fall
  // back to the data URL stored inline if no path was uploaded.
  // Skip the source signedUrl in Electron desktop mode — the source
  // file lives at `<userData>/sessions/...`, never gets uploaded to
  // Supabase Storage, so a signed URL would 404 every time and just
  // pollute the console with `Object not found` warnings.
  const skipSourceSignedUrl = isElectron();
  const [thumbnailUrl, sourceUrl, renderUrl] = await Promise.all([
    resolveThumbnail(supabase, row.source_thumbnail),
    !skipSourceSignedUrl && row.source_path
      ? signedUrl(supabase, SOURCE_BUCKET, row.source_path)
      : Promise.resolve(null),
    resolveRenderUrl(supabase, row.render_url),
  ]);

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    version: typeof row.version === "number" ? row.version : null,

    sourcePath: row.source_path,
    sourceUrl,
    ext: row.source_ext ?? "",
    thumbnail: thumbnailUrl,
    mediaKind: row.media_kind,

    spokenLanguage: row.spoken_language,
    spokenLanguageLabel: row.spoken_language_label,
    writingScript: row.writing_script,
    writingScriptLabel: row.writing_script_label,
    translateToEnglish: row.translate_to_english,

    provider: (row.transcribe_provider ?? undefined) as TranscribeProvider | undefined,
    whisper: {
      task: row.translate_to_english ? "translate" : "transcribe",
      language: row.spoken_language,
      duration: row.duration_sec,
      text: row.transcript_text ?? "",
      words: row.transcript_words,
    },

    styleId: row.style_id as CaptionStyleId,
    styleOverrides: (row.style_overrides ?? {}) as CaptionStyleOverrides,
    // Casts — the Supabase type generic predates these columns
    // (line_animations from migration 004; the rest from 008). The
    // runtime shape is correct.
    //
    // Each falls back to an empty value, which matters for rows created
    // before migration 008 ran: those have SQL NULL rather than the
    // column default, and the editor must open them as "no overrides"
    // rather than crashing on a null map.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lineAnimations: (((row as any).line_animations ?? {}) as Record<string, string>),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lineStyles: (((row as any).line_styles ?? {}) as Record<string, CaptionStyleId>),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wordSizes: (((row as any).word_sizes ?? {}) as Record<string, number>),
    userBreaks: Array.isArray((row as unknown as { user_breaks?: unknown }).user_breaks)
      ? ((row as unknown as { user_breaks: number[] }).user_breaks)
      : [],

    renderStatus: row.render_status,
    renderUrl,
    renderedAt: row.rendered_at ? new Date(row.rendered_at).getTime() : null,
  };
}

/**
 * Turn the stored `render_url` into something a browser can actually
 * open.
 *
 * The column holds two different things depending on which mode produced
 * the render:
 *   - web mode:     a storage path, `<uid>/<projectId>.mp4`
 *   - desktop mode: an absolute path on the user's own disk
 *
 * It used to be passed through untouched while being typed and documented
 * as "signed URL for the rendered MP4" — so the web-mode value was a
 * bucket path masquerading as a URL. Nothing consumed the field yet, so
 * nothing visibly broke, but the first consumer would have failed
 * differently in each mode.
 *
 * Desktop absolute paths are returned as-is: they're for
 * `revealInOSFileManager`, not for an <a href>. BUT only when we're
 * actually running inside the desktop shell right now — the same
 * `isElectron()` guard `sourcePath` resolution already uses a few lines
 * below (`skipSourceSignedUrl`). Without it, a project rendered on
 * desktop and later opened from a browser (same account, different
 * machine/session) got its raw local filesystem path — e.g.
 * `C:\Users\...\out.mp4` — handed back as if it were a usable URL. Any
 * caller gating on "renderUrl is truthy → show a download/open link"
 * would render a link that can never work in a browser tab, with
 * nothing telling the user why. Treating it as "no render available"
 * instead is honest: from a browser, that file genuinely isn't
 * reachable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveRenderUrl(
  supabase: any,
  raw: string | null
): Promise<string | null> {
  if (!raw) return null;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  // Desktop mode writes a local filesystem path. Windows drive letters
  // ("C:\…") and POSIX absolute paths ("/Users/…") both land here; a
  // storage key is always "<uuid>/<uuid><ext>" with no leading slash.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    return isElectron() ? raw : null;
  }
  return signedUrl(supabase, RENDERS_BUCKET, raw);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveThumbnail(
  supabase: any,
  raw: string | null
): Promise<string | null> {
  if (!raw) return null;
  // Data URLs and absolute http(s) URLs pass through unchanged.
  if (raw.startsWith("data:") || raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }
  // Otherwise treat as a storage path in the thumbnails bucket.
  return signedUrl(supabase, THUMBNAILS_BUCKET, raw);
}
