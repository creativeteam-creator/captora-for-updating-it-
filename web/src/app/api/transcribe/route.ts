import { NextRequest, NextResponse } from "next/server";
import { mkdir, unlink, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join, extname } from "path";
import { tmpdir } from "os";
import { transcribe } from "@/lib/transcribe";
import type { AccuracyTier } from "@/lib/whisper";
import {
  WRITING_SCRIPTS,
  getSpokenLanguage,
  type WritingScript,
} from "@/lib/languages";
import { createClient } from "@/lib/supabase/server";
import {
  SOURCE_BUCKET,
  uploadThumbnail,
} from "@/lib/supabase/storage";
import { downloadToFile } from "@/lib/supabase/storage-server";
import { isDesktopMode, getLocalSessionsDir } from "@/lib/captora-mode";

export const runtime = "nodejs";
export const maxDuration = 300; // seconds — first call downloads the model

/**
 * Working directory for Whisper. Whisper / faster-whisper need a real
 * filesystem path. In WEB mode we land downloads here from Supabase
 * Storage and render reuses the cached copy. In DESKTOP mode the
 * Electron main process passes us its own user-data sessions dir via
 * `CAPTORA_SESSIONS_DIR` so the file is already on disk and survives
 * the 12-hour cleanup window.
 */
const WEB_SESSION_DIR = join(tmpdir(), "captora-sessions");
function sessionDir(): string {
  return isDesktopMode() && getLocalSessionsDir()
    ? getLocalSessionsDir()
    : WEB_SESSION_DIR;
}

const AUDIO_EXTS = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".wma",
]);

/**
 * Delete temp files older than maxAgeMs from sessionDir().
 * Runs silently in the background — never blocks the response.
 * Called once per transcription request so disk doesn't fill up.
 */
async function cleanupOldTempFiles(maxAgeMs = 48 * 60 * 60 * 1000): Promise<void> {
  try {
    const { readdir, stat, unlink: del } = await import("fs/promises");
    const files = await readdir(sessionDir()).catch(() => [] as string[]);
    const now = Date.now();
    let deleted = 0;
    let freedBytes = 0;
    for (const f of files) {
      const fp = join(sessionDir(), f);
      const s = await stat(fp).catch(() => null);
      if (!s) continue;
      const ageMs = now - s.mtimeMs;
      if (ageMs > maxAgeMs) {
        freedBytes += s.size;
        await del(fp).catch(() => {});
        deleted++;
      }
    }
    if (deleted > 0) {
      console.log(
        `[cleanup] removed ${deleted} temp file(s) older than 48h — freed ${(freedBytes / 1e6).toFixed(1)} MB`
      );
    }
  } catch {
    // Never throw — cleanup is best-effort
  }
}

export async function POST(req: NextRequest) {
  // Fire cleanup in the background — doesn't block the response.
  void cleanupOldTempFiles();

  try {
    // ───── Auth gate ─────
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Not signed in" },
        { status: 401 }
      );
    }

    // ───── JSON body parsing ─────
    // The browser uploads the source file directly to Supabase Storage
    // and then POSTs us a small JSON envelope referencing the storage
    // path. This avoids streaming gigabytes of multipart through the
    // Next.js dev server (undici was choking with `expected CRLF` /
    // `expected boundary after body` parser errors above 1GB).
    interface TranscribeBody {
      projectId?: string;
      storagePath?: string;
      ext?: string;
      title?: string;
      spokenLanguage?: string;
      writingScript?: WritingScript;
      translateToEnglish?: boolean;
      accuracy?: AccuracyTier;
      thumbnail?: string;
      fileName?: string;
      fileSize?: number;
      fileType?: string;
    }
    const body = (await req.json()) as TranscribeBody;

    const projectId = body.projectId;
    const storagePath = body.storagePath;
    if (!projectId || !storagePath) {
      return NextResponse.json(
        { ok: false, error: "projectId and storagePath are required" },
        { status: 400 }
      );
    }
    // Storage RLS already scopes by `<user_id>/...` — double-check here so
    // a logged-in user can't accidentally pass another user's path.
    if (!storagePath.startsWith(`${user.id}/`)) {
      return NextResponse.json(
        { ok: false, error: "storagePath does not belong to the current user" },
        { status: 403 }
      );
    }

    const spokenLanguage =
      typeof body.spokenLanguage === "string" && body.spokenLanguage.length > 0
        ? body.spokenLanguage
        : "english";
    const writingScript: WritingScript =
      body.writingScript === "roman" ? "roman" : "native";
    const translateToEnglish = body.translateToEnglish === true;
    const accuracy: AccuracyTier =
      body.accuracy === "fast" || body.accuracy === "best" ? body.accuracy : "balanced";
    const fileName = body.fileName ?? "audio.mp3";
    const explicitTitle = typeof body.title === "string" ? body.title.trim() : "";
    const thumbnailDataUrl = typeof body.thumbnail === "string" ? body.thumbnail : "";

    const ext = (
      body.ext && body.ext.startsWith(".")
        ? body.ext
        : (extname(fileName) || ".mp3")
    ).toLowerCase();
    const mediaKind = AUDIO_EXTS.has(ext) ? "audio" : "video";
    const title = explicitTitle || fileName.replace(/\.[^.]+$/, "") || "Untitled";
    const fileSizeMB = body.fileSize ? (body.fileSize / 1024 / 1024).toFixed(2) : "?";

    console.log(
      `[/api/transcribe] user=${user.id} file=${fileName} size=${fileSizeMB}MB spoken=${spokenLanguage} script=${writingScript} translate=${translateToEnglish} accuracy=${accuracy} storagePath=${storagePath}`
    );

    // ───── Download from Supabase Storage to local tmp ─────
    // Whisper needs a real file path (CTranslate2 / faster-whisper opens
    // it via libsndfile), so we pull the bytes back from Storage. Yes,
    // this means client → Storage → server → tmp; but it keeps the
    // Next.js request body tiny and removes the gigabyte CRLF bug.
    await mkdir(sessionDir(), { recursive: true });
    const localPath = join(sessionDir(), `${projectId}${ext}`);
    try {
      // When the browser used the local-upload bypass (NEXT_PUBLIC_LOCAL_UPLOAD=true)
      // the file is already sitting at localPath — skip the Supabase download.
      if (existsSync(localPath)) {
        console.log(`[/api/transcribe] using cached local file: ${localPath}`);
      } else {
        await downloadToFile(supabase, SOURCE_BUCKET, storagePath, localPath);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { ok: false, error: `Failed to read uploaded source: ${msg}` },
        { status: 500 }
      );
    }

    try {
      // ───── Transcribe ─────
      const t0 = Date.now();
      const result = await transcribe({
        filePath: localPath,
        spokenLanguage,
        writingScript,
        translateToEnglish,
        accuracy,
      });
      console.log(
        `[/api/transcribe] ok in ${Date.now() - t0}ms — provider=${result.provider} words=${result.words.length} duration=${result.duration}s`
      );

      // ───── Upload thumbnail (source is already in Storage) ─────
      const thumbResult = thumbnailDataUrl
        ? await uploadThumbnail(supabase, user.id, projectId, thumbnailDataUrl).catch(
            (err: unknown) => {
              console.warn("[/api/transcribe] thumbnail upload failed:", err);
              return null;
            }
          )
        : null;

      // ───── Resolve labels for the project row ─────
      const lang = getSpokenLanguage(spokenLanguage);
      const spokenLanguageLabel = lang?.label ?? spokenLanguage;
      const writingScriptLabel = WRITING_SCRIPTS[writingScript].label;

      // ───── Insert project row ─────
      // Cast — @supabase/ssr's typed client doesn't satisfy the older
      // SupabaseClient<Database> shape; the schema is correct at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      const { data: inserted, error: insertErr } = await sb
        .from("projects")
        .insert({
          id: projectId,
          user_id: user.id,
          title,
          source_path: storagePath,
          source_ext: ext,
          source_thumbnail: thumbResult?.path ?? (thumbnailDataUrl || null),
          media_kind: mediaKind,
          spoken_language: spokenLanguage,
          spoken_language_label: spokenLanguageLabel,
          writing_script: writingScript,
          writing_script_label: writingScriptLabel,
          translate_to_english: translateToEnglish,
          transcribe_provider: result.provider,
          transcript_words: result.words,
          transcript_text: result.text,
          duration_sec: result.duration,
        })
        .select()
        .single();

      if (insertErr) {
        // Insert failed but transcription succeeded — give the user a
        // meaningful error and clean up the orphaned storage object the
        // browser uploaded.
        console.error("[/api/transcribe] DB insert failed:", insertErr.message);
        supabase.storage.from(SOURCE_BUCKET).remove([storagePath]).catch(() => {});
        return NextResponse.json(
          { ok: false, error: `Project save failed: ${insertErr.message}` },
          { status: 500 }
        );
      }

      // Local file stays for /api/render to use; cleanup happens there.
      return NextResponse.json({
        ok: true,
        projectId,
        ext,
        provider: result.provider,
        result,
        project: inserted,
      });
    } catch (err) {
      // Transcription failure — drop the local copy.
      await unlink(localPath).catch(() => {});
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
    const status =
      err instanceof Error && "status" in err
        ? Number((err as { status?: number }).status) || 500
        : 500;
    console.error("[/api/transcribe] failed:", message, cause ?? "");
    if (err instanceof Error && err.stack) console.error(err.stack);
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
