/**
 * /api/glossary — user caption correction glossary.
 *
 * Stores word corrections in Supabase (production) with automatic
 * fallback to local glossary.json (dev mode / no-auth).
 *
 * GET    /api/glossary  → { entries: Record<string, string> }
 * POST   /api/glossary  → { ok: true }  body: { from, to }
 * DELETE /api/glossary  → { ok: true }  body: { from }
 */

import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const LOCAL_GLOSSARY_PATH = join(process.cwd(), "glossary.json");

/**
 * The local-file fallback is a DEVELOPMENT convenience for working
 * without a Supabase session. It must never run in production.
 *
 * It used to run whenever there was no signed-in user, and this route was
 * additionally exempted from the middleware auth gate — so on a deployed
 * instance anyone on the internet could POST here and append entries to a
 * JSON file on the server, unauthenticated and unbounded. The middleware
 * exemption is gone (see lib/supabase/middleware.ts) and this flag makes
 * the file path unreachable in production even if something else ever
 * routes around the gate.
 */
const ALLOW_LOCAL_FALLBACK = process.env.NODE_ENV === "development";

// ── Local JSON fallback (dev only) ──────────────────────────────────────────

async function readLocalGlossary(): Promise<Record<string, string>> {
  try {
    if (!existsSync(LOCAL_GLOSSARY_PATH)) return {};
    const raw = await readFile(LOCAL_GLOSSARY_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch { return {}; }
}

async function writeLocalGlossary(entries: Record<string, string>): Promise<void> {
  await writeFile(LOCAL_GLOSSARY_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function readSupabaseGlossary(userId: string): Promise<Record<string, string>> {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { data, error } = await sb
    .from("user_glossary")
    .select("from_word, to_word")
    .eq("user_id", userId);
  if (error || !data) return {};
  const entries: Record<string, string> = {};
  for (const row of data as { from_word: string; to_word: string }[]) {
    entries[row.from_word] = row.to_word;
  }
  return entries;
}

/**
 * Both writers throw on a Supabase error instead of ignoring it.
 *
 * They used to discard the result entirely, which is how the missing
 * `user_glossary` table went unnoticed for so long: every save returned
 * `{ ok: true }` to a UI that had no way to know the row went nowhere.
 * A write that fails should say so — the caller turns it into a 500, and
 * the server log names the cause.
 */
async function upsertSupabaseGlossary(
  userId: string, from: string, to: string
): Promise<void> {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { error } = await sb.from("user_glossary").upsert(
    { user_id: userId, from_word: from, to_word: to },
    { onConflict: "user_id,from_word" }
  );
  if (error) throw new Error(`glossary upsert failed: ${error.message}`);
}

async function deleteSupabaseGlossary(userId: string, from: string): Promise<void> {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { error } = await sb.from("user_glossary").delete()
    .eq("user_id", userId).eq("from_word", from);
  if (error) throw new Error(`glossary delete failed: ${error.message}`);
}

// ── Route handlers ───────────────────────────────────────────────────────────

/** 401 body shared by all three handlers. */
const UNAUTHORIZED = NextResponse.json(
  { ok: false, error: "Not signed in" },
  { status: 401 }
);

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    return NextResponse.json({ entries: await readSupabaseGlossary(user.id) });
  }
  if (ALLOW_LOCAL_FALLBACK) {
    return NextResponse.json({ entries: await readLocalGlossary() });
  }
  return UNAUTHORIZED.clone();
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { from?: string; to?: string };
    const from = body.from?.trim().toLowerCase();
    const to   = body.to?.trim();
    if (!from || !to) {
      return NextResponse.json({ ok: false, error: "from and to required" }, { status: 400 });
    }
    if (from === to.toLowerCase()) {
      return NextResponse.json({ ok: true, skipped: "same word" });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      await upsertSupabaseGlossary(user.id, from, to);
      console.log(`[glossary] supabase saved: "${from}" → "${to}" (user=${user.id.slice(0,8)})`);
    } else if (ALLOW_LOCAL_FALLBACK) {
      // Dev fallback — save to local JSON
      const entries = await readLocalGlossary();
      entries[from] = to;
      await writeLocalGlossary(entries);
      console.log(`[glossary] local saved: "${from}" → "${to}"`);
    } else {
      return UNAUTHORIZED.clone();
    }

    return NextResponse.json({ ok: true, from, to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = (await req.json()) as { from?: string };
    const from = body.from?.trim().toLowerCase();
    if (!from) {
      return NextResponse.json({ ok: false, error: "from required" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      await deleteSupabaseGlossary(user.id, from);
    } else if (ALLOW_LOCAL_FALLBACK) {
      const entries = await readLocalGlossary();
      delete entries[from];
      await writeLocalGlossary(entries);
    } else {
      return UNAUTHORIZED.clone();
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
