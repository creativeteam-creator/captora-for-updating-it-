import { NextRequest, NextResponse } from "next/server";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { copyFile, mkdir, readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { CaptionStyleId } from "@/lib/styles";
import { createClient } from "@/lib/supabase/server";
import {
  SOURCE_BUCKET,
  uploadRender,
} from "@/lib/supabase/storage";
import { downloadToFile } from "@/lib/supabase/storage-server";
import { isDesktopMode, getLocalRendersDir } from "@/lib/captora-mode";

export const runtime = "nodejs";
// Renders involve bundling (~10–30s first call), Chromium boot, and
// frame-by-frame encoding. Give it lots of headroom.
export const maxDuration = 600;

/** Map web-side style IDs to Remotion composition IDs. All styles share
 *  BoldViral as the host — visual variants flow via the `style` prop. */
const COMPOSITION_BY_STYLE: Record<CaptionStyleId, string> = {
  "bold-viral": "BoldViral",
  "clean-medical": "CleanMedical",
  "tech-minimal": "TechMinimal",
  "captora-glow":   "BoldViral",
  "captora-shadow": "BoldViral",
  "captora":        "BoldViral",
  "ali-abdaal":     "BoldViral",
  "tiktok-top":     "BoldViral",
  "caption-bottom": "BoldViral",
  "center-power":   "BoldViral",
  "word-chips":     "BoldViral",
  "bouncy-mix":     "BoldViral",
  "kinetic-pop":    "BoldViral",
  "slide-cascade":  "BoldViral",
  "blur-reveal":    "BoldViral",
  "drop-stack":     "BoldViral",
  "rotate-flair":   "BoldViral",
};

const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".wma"]);

const SESSION_DIR = join(tmpdir(), "captora-sessions");
const REMOTION_ROOT = resolve(process.cwd(), "..", "remotion");
const REMOTION_ENTRY = join(REMOTION_ROOT, "src", "index.ts");

/**
 * Port used by Remotion's internal serve-static for the bundle. Must NOT
 * collide with Next.js dev server (3000) — when it does, Chromium loads
 * our /login page instead of the bundle's `index.html` and dies looking
 * for `window.getStaticCompositions`. Pick a port we control.
 */
const RENDER_PORT = 3301;

let bundlePromise: Promise<string> | null = null;
function getBundle(): Promise<string> {
  if (!bundlePromise) {
    console.log(`[/api/render] bundling Remotion entry: ${REMOTION_ENTRY}`);
    bundlePromise = bundle({ entryPoint: REMOTION_ENTRY }).then((url) => {
      console.log(`[/api/render] bundle ready: ${url}`);
      return url;
    });
  }
  return bundlePromise;
}

interface RenderBody {
  projectId?: string;
  ext?: string;
  style?: CaptionStyleId;
  words?: Array<{ word: string; start: number; end: number }>;
  durationSec?: number;
  computedStyle?: Record<string, unknown>;
  /**
   * When true: render with a transparent background and VP9 codec, output
   * `.webm` with a real alpha channel. The user can then drop the file
   * straight onto their own footage in any editor — no more screen-blend
   * tricks to remove black.
   */
  transparent?: boolean;
  /**
   * User-uploaded fonts (with signed URLs). Forwarded to the composition
   * via inputProps so the FontLoader inside the bundle can register the
   * @font-face before frames render — otherwise the renderer falls back
   * to the system default and the chosen family is silently lost.
   */
  customFonts?: Array<{ family: string; url: string; format: "ttf" | "otf" | "woff" | "woff2" }>;
  /**
   * Output canvas dimensions, derived from the dropped media's aspect.
   * Forwarded as inputProps — Root.tsx's calculateMetadata picks them
   * up so selectComposition returns the right size, and the rendered
   * MP4 / MOV comes out at that aspect (9:16, 16:9, 1:1, 4:5, …).
   */
  width?: number;
  height?: number;
  /**
   * Per-line entrance-animation overrides keyed by centisecond start
   * time. Forwarded into the composition so the rendered MP4 matches
   * the user's per-line picks from the editor.
   */
  lineAnimations?: Record<string, string>;
  /**
   * Per-line FULL template overrides keyed by centisecond start time.
   * Each value is a fully-merged CaptionStyle object (preset + the
   * project's global Text-panel overrides). The composition uses
   * these in place of the project-wide `computedStyle` for matching
   * lines, letting one project mix templates per line.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lineStyles?: Record<string, any>;
}

/**
 * Locate the source media on the local filesystem. Tries the
 * tmpdir-cache first (fresh transcribes leave a copy there) and falls
 * back to downloading from Supabase Storage for projects opened from
 * Recent Videos.
 */
async function ensureLocalSource(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  projectId: string,
  ext: string,
  storagePath: string | null
): Promise<string> {
  const cached = join(SESSION_DIR, `${projectId}${ext}`);
  if (existsSync(cached)) return cached;

  if (!storagePath) {
    throw new Error(
      `Source media missing for project ${projectId}. Re-upload and transcribe.`
    );
  }

  // Download from Supabase Storage. Path convention: <userId>/<projectId>.<ext>.
  void userId; // referenced in path RLS but not needed here.
  await mkdir(SESSION_DIR, { recursive: true });
  await downloadToFile(supabase, SOURCE_BUCKET, storagePath, cached);
  return cached;
}

export async function POST(req: NextRequest) {
  let publicAssetPath: string | null = null;
  let outPath: string | null = null;

  try {
    // ───── Auth gate ─────
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
    }

    // ───── Parse + validate body ─────
    const body = (await req.json()) as RenderBody;
    const { projectId, ext, style, words, durationSec, computedStyle, transparent, customFonts, width, height, lineAnimations, lineStyles } = body;
    if (!projectId || !ext || !style || !Array.isArray(words)) {
      return NextResponse.json(
        { ok: false, error: "Missing required fields: projectId, ext, style, words" },
        { status: 400 }
      );
    }
    const compositionId = COMPOSITION_BY_STYLE[style];
    if (!compositionId) {
      return NextResponse.json({ ok: false, error: `Unknown style: ${style}` }, { status: 400 });
    }

    // ───── Look up project + locate source media ─────
    const { data: project, error: lookupErr } = await supabase
      .from("projects")
      .select("source_path")
      .eq("id", projectId)
      .maybeSingle();
    if (lookupErr || !project) {
      return NextResponse.json(
        { ok: false, error: `Project ${projectId} not found` },
        { status: 404 }
      );
    }

    // Cast — TS struggles to flow our Database generic through the SSR
    // client wrapper. Schema is correct at runtime; cast keeps the build
    // green without weakening DB-layer guarantees.
    const sourcePath = (project as { source_path: string | null }).source_path;

    const sourceFile = await ensureLocalSource(
      supabase,
      user.id,
      projectId,
      ext,
      sourcePath
    );

    console.log(
      `[/api/render] user=${user.id} project=${projectId} style=${style} comp=${compositionId} words=${words.length} durationSec=${durationSec ?? "auto"}`
    );

    // Mark in-flight so other clients see the in-progress state.
    // Cast — see note above about Database-generic flow.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb: any = supabase;
    await sb.from("projects").update({ render_status: "rendering" }).eq("id", projectId);

    // ───── Bundle (cached across requests) ─────
    const tBundle = Date.now();
    const serveUrl = await getBundle();
    console.log(`[/api/render] bundle ready in ${Date.now() - tBundle}ms`);

    // ───── Stage source into bundle's public/ folder ─────
    const bundlePublic = join(serveUrl, "public");
    await mkdir(bundlePublic, { recursive: true });
    const publicName = `render-${projectId}-${randomUUID()}${ext}`;
    publicAssetPath = join(bundlePublic, publicName);
    await copyFile(sourceFile, publicAssetPath);

    const isAudioOnly = AUDIO_EXTS.has(ext.toLowerCase());
    const inputProps = {
      words,
      fps: 30,
      videoSrc: isAudioOnly ? undefined : publicName,
      audioSrc: isAudioOnly ? publicName : undefined,
      durationSec,
      style: computedStyle,
      transparentBackground: !!transparent,
      customFonts: Array.isArray(customFonts) ? customFonts : undefined,
      // calculateMetadata in remotion/src/Root.tsx reads these and
      // overrides the registered <Composition> default (1080×1920) so
      // the rendered file matches the dropped media's aspect ratio.
      width: typeof width === "number" && width > 0 ? width : undefined,
      height: typeof height === "number" && height > 0 ? height : undefined,
      // Per-line entrance overrides — empty object behaves the same as
      // omitted (composition falls back to the cyclic default).
      lineAnimations:
        lineAnimations && typeof lineAnimations === "object" && Object.keys(lineAnimations).length > 0
          ? lineAnimations
          : undefined,
      // Per-line full-template overrides — already merged with global
      // overrides on the writer side, so the composition can use them
      // directly without re-importing the style catalogue. Empty
      // object → no per-line picks, fall back to project-wide style.
      lineStyles:
        lineStyles && typeof lineStyles === "object" && Object.keys(lineStyles).length > 0
          ? lineStyles
          : undefined,
    };
    console.log(
      `[/api/render] canvas: ${inputProps.width ?? "default"}×${inputProps.height ?? "default"}`
    );
    console.log(
      `[/api/render] media kind: ${isAudioOnly ? "audio (black bg)" : "video"} ${transparent ? "(TRANSPARENT)" : ""}`
    );

    // ───── Render ─────
    // Explicit `port` is critical — without it, Remotion's internal
    // serve-static defaults to 3000 and collides with the Next.js dev
    // server. Chromium then loads our /login page instead of the
    // bundle's index.html and dies looking for `getStaticCompositions`.
    const tComp = Date.now();
    const composition = await selectComposition({
      serveUrl,
      id: compositionId,
      inputProps,
      port: RENDER_PORT,
    });
    console.log(
      `[/api/render] composition selected in ${Date.now() - tComp}ms — ${composition.durationInFrames} frames @ ${composition.fps}fps`
    );

    // Transparent renders use **ProRes 4444 in a .mov container** —
    // the industry-standard alpha format. Premiere / After Effects /
    // DaVinci / FCP all import natively.
    //
    // Three things must line up for the alpha to actually survive:
    //   1. codec  = "prores" + proResProfile = "4444"  (alpha-capable encoder)
    //   2. pixelFormat = "yuva444p10le"                  (alpha-bearing pixel layout)
    //   3. imageFormat = "png"                           (Chromium frame capture
    //      must keep alpha; the default `jpeg` strips it and you get black bg)
    const codec = transparent ? "prores" : "h264";
    const outExt = transparent ? "mov" : "mp4";
    const contentType = transparent ? "video/quicktime" : "video/mp4";

    outPath = join(tmpdir(), `captora-render-${randomUUID()}.${outExt}`);
    const tRender = Date.now();
    await renderMedia({
      composition,
      serveUrl,
      codec,
      proResProfile: transparent ? "4444" : undefined,
      pixelFormat: transparent ? "yuva444p10le" : undefined,
      // PNG keeps alpha; JPEG (the project default in remotion.config.ts)
      // would silently flatten transparency to black.
      imageFormat: transparent ? "png" : "jpeg",
      outputLocation: outPath,
      inputProps,
      port: RENDER_PORT,
    });
    console.log(
      `[/api/render] rendered in ${Date.now() - tRender}ms (codec=${codec}${transparent ? " 4444 alpha" : ""})`
    );

    const mp4 = await readFile(outPath);

    // ───── Persist the render ─────
    // WEB mode: upload to Supabase Storage so the user can re-download
    //           later from any device.
    // DESKTOP mode: write to the local renders folder under the
    //           Electron user-data dir. Cloud upload is skipped — the
    //           file lives on the user's PC and is also streamed back
    //           to the browser as a download below. Desktop projects
    //           store the local path in `render_url` so the home
    //           screen's "Recent" thumbnails can resolve it.
    let renderRefPath: string | null = null;
    if (isDesktopMode() && getLocalRendersDir()) {
      try {
        const localRendersDir = getLocalRendersDir();
        await mkdir(localRendersDir, { recursive: true });
        const safeProject = projectId.slice(0, 8);
        const targetName = `captora-${style}-${safeProject}.${outExt}`;
        const targetPath = join(localRendersDir, targetName);
        await copyFile(outPath, targetPath);
        renderRefPath = targetPath;
        console.log(`[/api/render] desktop-mode → saved to ${targetPath}`);
      } catch (err) {
        console.warn("[/api/render] local render copy failed:", err);
      }
    } else {
      const upload = await uploadRender(supabase, user.id, projectId, mp4).catch(
        (err) => {
          console.warn("[/api/render] upload to storage failed:", err);
          return null;
        }
      );
      renderRefPath = upload?.path ?? null;
    }

    await sb
      .from("projects")
      .update({
        render_status: "rendered",
        render_url: renderRefPath,
        rendered_at: new Date().toISOString(),
      })
      .eq("id", projectId);

    // ───── Stream rendered file back to caller ─────
    const filename = `captora-${style}-${projectId.slice(0, 8)}.${outExt}`;
    return new NextResponse(new Uint8Array(mp4), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(mp4.byteLength),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/render] failed:", message);
    if (err instanceof Error && err.stack) console.error(err.stack);
    // Best-effort: mark the project failed so the editor can surface it.
    try {
      const body = (await req.clone().json().catch(() => ({}))) as RenderBody;
      if (body.projectId) {
        const supabase = await createClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failSb: any = supabase;
        await failSb
          .from("projects")
          .update({ render_status: "failed" })
          .eq("id", body.projectId);
      }
    } catch {
      /* swallow — already handling an error */
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    if (publicAssetPath) await unlink(publicAssetPath).catch(() => {});
    if (outPath) await unlink(outPath).catch(() => {});
  }
}
