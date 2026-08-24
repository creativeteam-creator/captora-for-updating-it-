-- Captora — per-user caption correction glossary.
--
-- Run this in your Supabase SQL Editor after `008_editor_state.sql`.
--
-- Problem this solves: `/api/glossary` has always read and written a
-- `public.user_glossary` table for signed-in users, but that table was
-- never created by a migration. Every correction a user made by editing
-- a word in the captions list was POSTed, upserted into a table that
-- doesn't exist, and lost — the route never checked the error, so it
-- reported success and the UI showed nothing wrong.
--
-- The local `glossary.json` fallback masked this during development
-- (dev mode writes the file instead), which is why the feature looked
-- like it worked right up until it was deployed.
--
-- Shape mirrors what the route already expects:
--   (user_id, from_word) is the natural key — the route upserts with
--   `onConflict: "user_id,from_word"`, so it needs a matching unique
--   constraint to conflict against. A composite primary key provides it.
--
-- `from_word` is stored lowercase (the route lowercases before writing)
-- because lookups are case-insensitive: the transcript pipeline lowers
-- each word before checking the table.

-- ─── user_glossary table ────────────────────────────────────────────────
create table if not exists public.user_glossary (
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- What the STT emitted, lowercased.
  from_word  text not null,
  -- What should appear in the caption instead. Case preserved — a
  -- correction to a proper noun ("QHT", "Haridwar") depends on it.
  to_word    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, from_word)
);

-- Read pattern is "give me this user's whole glossary" at the start of
-- each transcription, which the primary key's leading column already
-- covers. No secondary index needed.

alter table public.user_glossary enable row level security;

drop policy if exists "Users read own glossary"   on public.user_glossary;
drop policy if exists "Users insert own glossary" on public.user_glossary;
drop policy if exists "Users update own glossary" on public.user_glossary;
drop policy if exists "Users delete own glossary" on public.user_glossary;

create policy "Users read own glossary"
  on public.user_glossary for select using (auth.uid() = user_id);
create policy "Users insert own glossary"
  on public.user_glossary for insert with check (auth.uid() = user_id);
create policy "Users update own glossary"
  on public.user_glossary for update using (auth.uid() = user_id);
create policy "Users delete own glossary"
  on public.user_glossary for delete using (auth.uid() = user_id);

drop trigger if exists user_glossary_set_updated_at on public.user_glossary;
create trigger user_glossary_set_updated_at
  before update on public.user_glossary
  for each row execute function public.set_updated_at();

comment on table public.user_glossary is
  'Per-user caption corrections. Applied during transcription after the Hinglish polish step; user entries override the built-in clinic glossary.';
