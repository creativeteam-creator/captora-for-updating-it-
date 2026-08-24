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
import { getUserApiKeys } from "@/lib/userApiKeys";
import { getUserGlossary } from "@/lib/userGlossary";
import { withRequestContext } from "@/lib/requestContext";
import { reportServerEvent } from "@/lib/telemetry-server";
import { isValidProjectId, safeMediaExt } from "@/lib/pathSafety";

export const runtime = "nodejs";
// 30-min cap so long-form content (clinic consultations / training videos up
// to 40 min) finishes the full pipeline — upload + ElevenLabs server-side
// processing + Hinglish LLM polish + DB insert. The old 5-min cap chopped
// off legitimate 20-40 min audio mid-process and silently dropped the user
// onto local CPU Whisper, which is the "good for 2-min files, bad for
// 20-min files" quality cliff the team was reporting.
export const maxDuration = 1800;

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

  // Diagnostic breadcrumbs for crash reporting. Declared out here so the
  // catch block can see them — the request body is parsed inside the try
  // and would otherwise be out of scope exactly when we need it most.
  // Filled in progressively, so a failure reports everything known up to
  // the point it broke.
  const diag: Record<string, unknown> = {};

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
      /** Desktop-mode authoritative path. When present, the route uses
       *  this exact path on disk instead of recomputing
       *  `sessionDir + projectId + ext`. Set by page.tsx from the value
       *  the Electron IPC bridge reports it wrote to. Eliminates the
       *  path-drift bug where two different processes each recompute
       *  `app.getPath("userData")` and somehow disagree. */
      localFilePath?: string;
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
    // projectId is concatenated into on-disk paths below. Require a real
    // UUID so it can't carry a separator or a `..` segment.
    if (!isValidProjectId(projectId)) {
      return NextResponse.json(
        { ok: false, error: "projectId must be a UUID" },
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

    // Extension goes straight into a filename, so it's allow-listed
    // rather than merely checked for a leading dot — `"../../evil"`
    // passes `.startsWith(".")`, which is what the old check did.
    // Falls back to the uploaded filename's own extension before giving
    // up, so a client that omits `ext` still works.
    const ext = safeMediaExt(body.ext) ?? safeMediaExt(extname(fileName));
    if (!ext) {
      return NextResponse.json(
        {
          ok: false,
          error:
            `Unsupported media type "${body.ext ?? extname(fileName) ?? "unknown"}". ` +
            `Upload a video (mp4, mov, webm, mkv, avi, m4v, 3gp) or audio ` +
            `(mp3, wav, m4a, aac, ogg, flac, opus, wma) file.`,
        },
        { status: 400 }
      );
    }
    const mediaKind = AUDIO_EXTS.has(ext) ? "audio" : "video";
    const title = explicitTitle || fileName.replace(/\.[^.]+$/, "") || "Untitled";
    const fileSizeMB = body.fileSize ? (body.fileSize / 1024 / 1024).toFixed(2) : "?";

    Object.assign(diag, {
      projectId,
      ext,
      mediaKind,
      spokenLanguage,
      writingScript,
      translateToEnglish,
      accuracy,
      fileSizeBytes: body.fileSize ?? null,
      desktopMode: isDesktopMode(),
    });

    console.log(
      `[/api/transcribe] user=${user.id} file=${fileName} size=${fileSizeMB}MB spoken=${spokenLanguage} script=${writingScript} translate=${translateToEnglish} accuracy=${accuracy} storagePath=${storagePath}`
    );

    // ───── Locate / fetch the source file ─────
    // Two paths converge here:
    //   - WEB mode:  source was uploaded to Supabase Storage by the
    //                browser; we download to tmp now.
    //   - DESKTOP mode: page.tsx passed `localFilePath` — the exact
    //                absolute path the IPC bridge reports it wrote to.
    //                We use that path verbatim. Never recompute
    //                `sessionDir + projectId + ext` server-side, never
    //                fall back to Supabase. Eliminates the
    //                path-drift class of bugs where Electron main and
    //                the spawned Next.js child each compute
    //                `app.getPath("userData")` and disagree.
    await mkdir(sessionDir(), { recursive: true });
    const reconstructedPath = join(sessionDir(), `${projectId}${ext}`);
    // Prefer the IPC-returned path. Fall back to the reconstructed one
    // if the renderer somehow forgot to send it (defensive).
    //
    // SECURITY: `localFilePath` is honoured ONLY in desktop mode. It is a
    // raw absolute path chosen by the client, and in web mode it became
    // the destination of the Supabase download below — letting any
    // signed-in user write their uploaded file anywhere the server
    // process could write, and read back any media file already on the
    // server as a "transcript". On the desktop build the client and the
    // server are the same machine and the same user, so trusting it there
    // grants nothing they don't already have; on a shared web deploy it
    // grants a great deal. The mode check is the whole difference.
    const localPath =
      isDesktopMode() && body.localFilePath ? body.localFilePath : reconstructedPath;
    if (!isDesktopMode() && body.localFilePath) {
      console.warn(
        "[/api/transcribe] ignoring client-supplied localFilePath outside desktop mode"
      );
    }
    console.log(
      `[/api/transcribe] localPath=${localPath} reconstructedPath=${reconstructedPath} desktopMode=${isDesktopMode()}`
    );

    // Tiny retry loop for AV / file-system flush races. existsSync can
    // briefly return false right after copyFile completes if Windows
    // Defender is mid-scan or the OS hasn't finished flushing buffers.
    // 5 × 100ms = max 500ms wait, after which we conclude the file is
    // genuinely missing.
    let localExists = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (existsSync(localPath)) {
        localExists = true;
        if (attempt > 0) {
          console.log(`[/api/transcribe] file appeared after ${attempt * 100}ms wait`);
        }
        break;
      }
      if (attempt === 4) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    try {
      if (localExists) {
        console.log(`[/api/transcribe] using local file: ${localPath}`);
      } else if (isDesktopMode()) {
        return NextResponse.json(
          {
            ok: false,
            error:
              `Source file not found at ${localPath} (also checked ${reconstructedPath}). ` +
              `Waited 500ms for filesystem flush. ` +
              `The IPC bridge may have failed or AV quarantined the file. ` +
              `Re-drop the original file to retry.`,
          },
          { status: 500 }
        );
      } else {
        // WEB mode: download from Supabase Storage. This is the
        // legitimate cloud path used by the VPS deploy.
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
      // ───── Resolve per-user API keys ─────
      // Pulls Gemini / Groq overrides from the Settings panel (stored in
      // public.user_api_keys). Falls through to the bundled .env keys when
      // the user hasn't supplied their own. Wrapping the transcribe() call
      // in withRequestContext makes the keys readable via AsyncLocalStorage
      // anywhere downstream — no need to thread them through every fn.
      const userKeys = await getUserApiKeys(supabase, user.id);
      console.log(
        `[/api/transcribe] user keys: gemini=${userKeys.geminiApiKey ? "user-set" : "bundled"} groq=${userKeys.groqApiKey ? "user-set" : "bundled"}`
      );

      // ───── Resolve the user's caption corrections ─────
      // Every word the user fixes in the captions list is POSTed to
      // /api/glossary. Reading those back here is what turns a one-off
      // correction into a permanent one: the same mishearing gets fixed
      // automatically on their next video. Rides the request context so
      // the transliteration code deep in the call tree can apply it
      // without the glossary being threaded through every signature.
      const userGlossary = await getUserGlossary(supabase, user.id);
      if (Object.keys(userGlossary).length > 0) {
        console.log(
          `[/api/transcribe] loaded ${Object.keys(userGlossary).length} user glossary correction(s)`
        );
      }

      // ───── Transcribe ─────
      // `requestWarnings` collects any structured notes the downstream
      // pipeline pushes — primarily quota-exhausted entries from
      // hinglish-llm.ts. We pass the array reference into the context
      // so downstream code can append; the route handler reads it
      // after transcribe() returns and forwards it to the client.
      const t0 = Date.now();
      const requestWarnings: import("@/lib/requestContext").RequestWarning[] = [];
      const result = await withRequestContext(
        {
          keyOverrides: {
            geminiApiKey: userKeys.geminiApiKey,
            groqApiKey: userKeys.groqApiKey,
          },
          warnings: requestWarnings,
          userGlossary,
        },
        () =>
          transcribe({
            filePath: localPath,
            spokenLanguage,
            writingScript,
            translateToEnglish,
            accuracy,
          })
      );
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
      // `warnings` carries quota-exhausted notes etc. so the editor can
      // show a toast like "aapki Gemini key ka quota khatam ho gaya".
      return NextResponse.json({
        ok: true,
        projectId,
        ext,
        provider: result.provider,
        result,
        project: inserted,
        warnings: requestWarnings,
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
    // A transcription failure means the whole provider chain (ElevenLabs
    // → Shunya → faster-whisper → Sarvam → Groq → local) was exhausted.
    // That's exactly the class of failure that used to be invisible.
    void reportServerEvent({
      event: "transcribe.failed",
      message,
      stack: err instanceof Error ? err.stack : undefined,
      context: { ...diag, status, cause: cause ? String(cause).slice(0, 500) : undefined },
    });
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
