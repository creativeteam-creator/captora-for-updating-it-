import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, unlink } from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { join } from "path";
import { tmpdir } from "os";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const SESSION_DIR = join(tmpdir(), "captora-sessions");

/**
 * Dev-only chunked upload endpoint.
 *
 * Large files are split into 8 MB chunks by the browser and POSTed
 * one at a time.  Each chunk is written to a numbered temp file; when
 * the LAST chunk arrives the server assembles all of them into the
 * final source file, then removes the chunk temps.
 *
 * Chunking is required because Next.js 15 dev server (undici) silently
 * truncates raw binary request bodies above ~a few MB, which caused only
 * the first 5 seconds of audio to survive a large video upload.
 *
 * URL params:
 *   projectId  – UUID of the project being created
 *   ext        – file extension including the dot, e.g. ".mp4"
 *   chunk      – 0-based index of this chunk
 *   total      – total number of chunks
 *
 * Returns: { ok: true, path: "<userId>/<projectId><ext>" }  (on last chunk)
 *          { ok: true, received: <chunk> }                   (on earlier chunks)
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      { ok: false, error: "Local upload is only available in development mode." },
      { status: 403 }
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const ext       = url.searchParams.get("ext") ?? "";
  const chunk     = parseInt(url.searchParams.get("chunk")  ?? "0", 10);
  const total     = parseInt(url.searchParams.get("total")  ?? "1", 10);

  if (!projectId) {
    return NextResponse.json(
      { ok: false, error: "projectId query param is required" },
      { status: 400 }
    );
  }

  await mkdir(SESSION_DIR, { recursive: true });

  // Write this chunk to a numbered temp file.
  const chunkPath = join(SESSION_DIR, `${projectId}.chunk${String(chunk).padStart(6, "0")}`);

  if (!req.body) {
    return NextResponse.json({ ok: false, error: "Empty request body" }, { status: 400 });
  }

  try {
    const nodeReadable = Readable.fromWeb(req.body as import("stream/web").ReadableStream);
    const ws = createWriteStream(chunkPath);
    await pipeline(nodeReadable, ws);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Chunk write failed: ${msg}` }, { status: 500 });
  }

  console.log(`[/api/upload-local] chunk ${chunk + 1}/${total} saved → ${chunkPath}`);

  // If this is not the last chunk, acknowledge and wait for the next one.
  if (chunk < total - 1) {
    return NextResponse.json({ ok: true, received: chunk });
  }

  // ── Last chunk: assemble all chunks into the final file ──────────────
  const finalPath = join(SESSION_DIR, `${projectId}${ext}`);
  try {
    const ws = createWriteStream(finalPath);

    for (let i = 0; i < total; i++) {
      const cp = join(SESSION_DIR, `${projectId}.chunk${String(i).padStart(6, "0")}`);
      const data = await readFile(cp);
      // Write synchronously within the stream via a promise so we can
      // await each write without risking out-of-order data.
      await new Promise<void>((resolve, reject) =>
        ws.write(data, (err) => (err ? reject(err) : resolve()))
      );
      await unlink(cp).catch(() => {}); // clean up chunk temp
    }

    await new Promise<void>((resolve) => ws.end(resolve));
    console.log(`[/api/upload-local] assembled ${total} chunks → ${finalPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Assembly failed: ${msg}` }, { status: 500 });
  }

  // Return a fake storage path whose first segment is the userId so the
  // RLS ownership check in /api/transcribe still passes.
  const fakePath = `${user.id}/${projectId}${ext}`;
  return NextResponse.json({ ok: true, path: fakePath });
}
