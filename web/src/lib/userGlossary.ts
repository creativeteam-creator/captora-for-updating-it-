/**
 * Per-user caption corrections, read server-side at the start of a
 * transcription.
 *
 * Backed by `public.user_glossary` (see migrations/009_user_glossary.sql).
 * Rows are written by `/api/glossary`, which the captions list POSTs to
 * silently every time a user edits a word — the idea being that
 * correcting "doaktar" once teaches Captora to correct it on every
 * future video.
 *
 * That loop was open at both ends before: the table had no migration, and
 * the transcription pipeline only ever read the dev-only `glossary.json`
 * file, never Supabase. This module closes the read half; the migration
 * closes the write half.
 *
 * Keys come back lowercased (the route lowercases on write) because
 * lookups are case-insensitive — the pipeline lowers each word before
 * checking.
 */

export type GlossaryEntries = Record<string, string>;

const TABLE = "user_glossary";

interface Row {
  from_word: string;
  to_word: string;
}

/**
 * Read the signed-in user's corrections. Returns `{}` for a user who has
 * never corrected anything, and also for any read failure — a glossary
 * that can't be loaded must degrade to "no corrections", never to a
 * failed transcription. The warning is logged so a missing table or a
 * broken policy is visible in the server log rather than silent.
 */
export async function getUserGlossary(
  // `any` rather than the strict generic: our `Database` type isn't
  // generated for this table, and the runtime contract is what matters.
  // Matches the convention in userApiKeys.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string
): Promise<GlossaryEntries> {
  const { data, error } = (await supabase
    .from(TABLE)
    .select("from_word, to_word")
    .eq("user_id", userId)) as {
    data: Row[] | null;
    error: { message: string } | null;
  };

  if (error) {
    console.warn("[userGlossary] read failed:", error.message);
    return {};
  }
  if (!data || data.length === 0) return {};

  const entries: GlossaryEntries = {};
  for (const row of data) {
    const from = (row.from_word ?? "").trim().toLowerCase();
    const to = (row.to_word ?? "").trim();
    if (!from || !to) continue;
    entries[from] = to;
  }
  return entries;
}
