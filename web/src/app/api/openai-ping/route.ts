import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Diagnostic-only: hits OpenAI's /v1/models JSON endpoint to confirm whether
 * the failure on /v1/audio/transcriptions is endpoint-specific (multipart
 * upload getting reset by a middlebox) or a general OpenAI connectivity issue.
 *
 * GET /api/openai-ping → { ok: true, modelCount: N } | { ok: false, error }
 *
 * Relies on the middleware's isApiPath 401 gate for auth today, but that
 * makes this route's protection a property of PUBLIC_PATHS staying
 * exactly as it is — an explicit check here means a future edit to that
 * list can't accidentally expose the connectivity-error detail below
 * (raw OpenAI SDK error message + code) to an unauthenticated caller.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
    }

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
