-- Captora — per-user override keys for cloud LLM providers.
--
-- Run this in your Supabase SQL Editor after `005_set_2gb_source_limit.sql`.
-- Adds:
--   - public.user_api_keys table (one row per user; rows omitted until user
--     supplies a key)
--   - RLS so users can read/write only their own row
--
-- The Captora server reads this row at the start of each /api/transcribe
-- call. If a user's key is present it's used in place of the bundled
-- production key; if absent, the bundled key (GEMINI_API_KEY /
-- GROQ_API_KEY from .env.production) is used. This gives per-user quota
-- isolation: one user transcribing heavily can't lock another user out
-- of polish.

-- ─── user_api_keys table ────────────────────────────────────────────────
create table if not exists public.user_api_keys (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  gemini_api_key text,
  groq_api_key   text,
  updated_at     timestamptz not null default now()
);

alter table public.user_api_keys enable row level security;

drop policy if exists "Users read own api keys"   on public.user_api_keys;
drop policy if exists "Users insert own api keys" on public.user_api_keys;
drop policy if exists "Users update own api keys" on public.user_api_keys;
drop policy if exists "Users delete own api keys" on public.user_api_keys;

create policy "Users read own api keys"
  on public.user_api_keys for select using (auth.uid() = user_id);
create policy "Users insert own api keys"
  on public.user_api_keys for insert with check (auth.uid() = user_id);
create policy "Users update own api keys"
  on public.user_api_keys for update using (auth.uid() = user_id);
create policy "Users delete own api keys"
  on public.user_api_keys for delete using (auth.uid() = user_id);
