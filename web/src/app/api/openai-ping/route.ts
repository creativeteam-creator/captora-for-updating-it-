import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

/**
 * Diagnostic-only: hits OpenAI's /v1/models JSON endpoint to confirm whether
 * the failure on /v1/audio/transcriptions is endpoint-specific (multipart
 * upload getting reset by a middlebox) or a general OpenAI connectivity issue.
 *
 * GET /api/openai-ping → { ok: true, modelCount: N } | { ok: false, error }
 */
export async function GET() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ ok: false, error: "OPENAI_API_KEY missing" }, { status: 500 });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 30_000,
      maxRetries: 0,
    });

    const t0 = Date.now();
    const list = await client.models.list();
    const ms = Date.now() - t0;

    let count = 0;
    for await (const _ of list) count++;

    return NextResponse.json({
      ok: true,
      modelCount: count,
      latencyMs: ms,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
    console.error("[/api/openai-ping] failed:", message, code ?? "");
    return NextResponse.json({ ok: false, error: message, code }, { status: 500 });
  }
}
