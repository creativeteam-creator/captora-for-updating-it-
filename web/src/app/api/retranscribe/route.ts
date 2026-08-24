import { NextRequest, NextResponse } from "next/server";
import { mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { transcribe } from "@/lib/transcribe";
import type { AccuracyTier } from "@/lib/whisper";
import type { WritingScript } from "@/lib/languages";
import { createClient } from "@/lib/supabase/server";
import { SOURCE_BUCKET } from "@/lib/supabase/storage";
import { downloadToFile } from "@/lib/supabase/storage-server";
import { isDesktopMode, getLocalSessionsDir } from "@/lib/captora-mode";
import { getUserApiKeys } from "@/lib/userApiKeys";
import { getUserGlossary } from "@/lib/userGlossary";
import { withRequestContext } from "@/lib/requestContext";
import { reportServerEvent } from "@/lib/telemetry-server";

/**
 * Re-transcribe an existing project. Same pipeline as /api/transcribe
 * but:
 *   - No file upload — reuses the project's stored source_path.
 *   - No project insert — UPDATES the existing row in place, replacing
 *     transcript_words, transcript_text, transcribe_provider, duration.
 *   - Language / accuracy settings can be overridden per call (default:
 *     keep whatever the project was originally transcribed with).
 *
 * Trigger: the editor's "Re-transcribe" button. Use case: STT gave rough
 * or wrong words on first attempt; user wants a fresh pass, optionally
 * with different accuracy tier. Any user edits to the caption text will
 * be OVERWRITTEN by the fresh transcript — that's the point.
 *
 * The client is responsible for confirming with the user before firing
 * this. The server unconditionally replaces the transcript.
 */

export const runtime = "nodejs";
// Same 30-min cap as /api/transcribe — retranscription runs the
// identical pipeline so it deserves the same time budget.
export const maxDuration = 1800;

const WEB_SESSION_DIR = join(tmpdir(), "captora-sessions");
function sessionDir(): string {
  return isDesktopMode() && getLocalSessionsDir()
    ? getLocalSessionsDir()
    : WEB_SESSION_DIR;
}

export async function POST(req: NextRequest) {
  try {
    // ───── Auth gate ─────
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Not signed in" },
        { status: 401 }
      );
    }

    interface Body {
      projectId?: string;
      /** Override the accuracy tier for this pass. Handy when the first
       *  attempt was "fast" and gave rough output — bump to "best" for
       *  a slower but more accurate second pass. */
      accuracy?: AccuracyTier;
      /** Override the language / script if the first pass had the wrong
       *  setting. Falls back to whatever the project row stored. */
      spokenLanguage?: string;
      writingScript?: WritingScript;
      translateToEnglish?: boolean;
      /** Desktop mode: authoritative local file path. Same as transcribe
       *  route — the client passes what the Electron IPC bridge reported. */
      localFilePath?: string;
    }
    const body = (await req.json()) as Body;
    if (!body.projectId) {
      return NextResponse.json(
        { ok: false, error: "projectId is required" },
        { status: 400 }
      );
    }

    // ───── Load existing project row ─────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb: any = supabase;
    const { data: project, error: loadErr } = await sb
      .from("projects")
      .select("*")
      .eq("id", body.projectId)
      .eq("user_id", user.id)
      .single();
    if (loadErr || !project) {
      return NextResponse.json(
        { ok: false, error: `Project not found: ${loadErr?.message ?? "unknown"}` },
        { status: 404 }
      );
    }
    if (!project.source_path) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Original source file reference is missing from this project — can't re-transcribe. Re-drop the file to create a new project.",
        },
        { status: 400 }
      );
    }

    // Settings: request overrides win; project row is fallback.
    const spokenLanguage = body.spokenLanguage ?? project.spoken_language ?? "english";
    const writingScript: WritingScript =
      body.writingScript === "roman"
        ? "roman"
        : body.writingScript === "native"
          ? "native"
          : project.writing_script === "roman"
            ? "roman"
            : "native";
    const translateToEnglish =
      typeof body.translateToEnglish === "boolean"
        ? body.translateToEnglish
        : Boolean(project.translate_to_english);
    const accuracy: AccuracyTier =
      body.accuracy === "fast" || body.accuracy === "best"
        ? body.accuracy
        : "balanced";
    const ext = (project.source_ext as string) || ".mp3";

    console.log(
      `[/api/retranscribe] user=${user.id} project=${body.projectId} spoken=${spokenLanguage} script=${writingScript} accuracy=${accuracy}`
    );

    // ───── Locate the source file ─────
    // DESKTOP: prefer the IPC-supplied localFilePath. If absent, fall
    // back to the reconstructed sessionDir + projectId + ext path.
    // WEB: download from Supabase Storage to a temp file.
    await mkdir(sessionDir(), { recursive: true });
    const reconstructedPath = join(sessionDir(), `${body.projectId}${ext}`);
    const localPath = body.localFilePath ?? reconstructedPath;
    let downloadedTemp = false;

    if (!existsSync(localPath)) {
      if (isDesktopMode()) {
        // Desktop file gone (cleanup, user deleted, drive unmounted).
        return NextResponse.json(
          {
            ok: false,
            error:
              `Source file not found at ${localPath}. ` +
              `The original file may have been deleted or moved. ` +
              `Re-drop the original file to retry.`,
          },
          { status: 404 }
        );
      }
      // WEB mode: pull from Supabase Storage.
      try {
        await downloadToFile(
          supabase,
          SOURCE_BUCKET,
          project.source_path,
          localPath
        );
        downloadedTemp = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
          { ok: false, error: `Failed to fetch stored source: ${msg}` },
          { status: 500 }
        );
      }
    }

    try {
      // ───── Resolve per-user API keys ─────
      const userKeys = await getUserApiKeys(supabase, user.id);
      console.log(
        `[/api/retranscribe] user keys: gemini=${userKeys.geminiApiKey ? "user-set" : "bundled"} groq=${userKeys.groqApiKey ? "user-set" : "bundled"}`
      );

      // ───── Resolve the user's caption corrections ─────
      // Same reasoning as /api/transcribe: a re-transcribe discards the
      // user's manual word edits by design, so their saved glossary is
      // the only thing carrying those corrections into the fresh pass.
      const userGlossary = await getUserGlossary(supabase, user.id);
      if (Object.keys(userGlossary).length > 0) {
        console.log(
          `[/api/retranscribe] loaded ${Object.keys(userGlossary).length} user glossary correction(s)`
        );
      }

      // ───── Transcribe (same pipeline as first-time) ─────
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
        `[/api/retranscribe] ok in ${Date.now() - t0}ms — provider=${result.provider} words=${result.words.length} duration=${result.duration}s`
      );

      // ───── UPDATE the existing project row ─────
      // Only the transcription-derived fields change; keep title,
      // style_id, style_overrides, render_url, etc. as they were.
      const { data: updated, error: updateErr } = await sb
        .from("projects")
        .update({
          spoken_language: spokenLanguage,
          writing_script: writingScript,
          translate_to_english: translateToEnglish,
          transcribe_provider: result.provider,
          transcript_words: result.words,
          transcript_text: result.text,
          duration_sec: result.duration,
          updated_at: new Date().toISOString(),
        })
        .eq("id", body.projectId)
        .eq("user_id", user.id)
        .select()
        .single();

      if (updateErr) {
        console.error("[/api/retranscribe] DB update failed:", updateErr.message);
        return NextResponse.json(
          { ok: false, error: `Project save failed: ${updateErr.message}` },
          { status: 500 }
        );
      }

      return NextResponse.json({
        ok: true,
        projectId: body.projectId,
        ext,
        provider: result.provider,
        result,
        project: updated,
        warnings: requestWarnings,
      });
    } finally {
      // Only clean up the temp file if WE downloaded it just now — the
      // desktop-mode file lives at a persistent user-data path and must
      // NOT be deleted (the editor still needs it for renders).
      if (downloadedTemp) {
        await unlink(localPath).catch(() => {});
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/retranscribe] failed:", message);
    if (err instanceof Error && err.stack) console.error(err.stack);
    void reportServerEvent({
      event: "retranscribe.failed",
      message,
      stack: err instanceof Error ? err.stack : undefined,
      context: { desktopMode: isDesktopMode() },
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
