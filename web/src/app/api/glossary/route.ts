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

async function upsertSupabaseGlossary(
  userId: string, from: string, to: string
): Promise<void> {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  await sb.from("user_glossary").upsert(
    { user_id: userId, from_word: from, to_word: to },
    { onConflict: "user_id,from_word" }
  );
}

async function deleteSupabaseGlossary(userId: string, from: string): Promise<void> {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  await sb.from("user_glossary").delete()
    .eq("user_id", userId).eq("from_word", from);
}

// ── Route handlers ───────────────────────────────────────────────────────────

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let entries: Record<string, string>;
  if (user) {
    entries = await readSupabaseGlossary(user.id);
  } else {
    entries = await readLocalGlossary();
  }
  return NextResponse.json({ entries });
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
    } else {
      // Dev fallback — save to local JSON
      const entries = await readLocalGlossary();
      entries[from] = to;
      await writeLocalGlossary(entries);
      console.log(`[glossary] local saved: "${from}" → "${to}"`);
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
    } else {
      const entries = await readLocalGlossary();
      delete entries[from];
      await writeLocalGlossary(entries);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
