-- Captora — custom user-uploaded fonts.
--
-- Run this in your Supabase SQL Editor after `001_init.sql`. Adds:
--   - public.user_fonts table  (one row per uploaded font)
--   - captora-fonts storage bucket
--   - RLS so users only see / mutate their own fonts
--
-- Storage layout convention enforced by the policy below:
--   captora-fonts/<user_id>/<font_id>.<ext>

-- ─── user_fonts table ───────────────────────────────────────────────────
create table if not exists public.user_fonts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  family        text not null,                                          -- display name, e.g. "Acme Display"
  storage_path  text not null,                                          -- "<user_id>/<font_id>.ttf"
  format        text not null check (format in ('ttf', 'otf', 'woff', 'woff2')),
  created_at    timestamptz not null default now()
);

create index if not exists user_fonts_user_id_created_at_idx
  on public.user_fonts (user_id, created_at desc);

alter table public.user_fonts enable row level security;

drop policy if exists "Users read own fonts"   on public.user_fonts;
drop policy if exists "Users insert own fonts" on public.user_fonts;
drop policy if exists "Users update own fonts" on public.user_fonts;
drop policy if exists "Users delete own fonts" on public.user_fonts;

create policy "Users read own fonts"
  on public.user_fonts for select using (auth.uid() = user_id);
create policy "Users insert own fonts"
  on public.user_fonts for insert with check (auth.uid() = user_id);
create policy "Users update own fonts"
  on public.user_fonts for update using (auth.uid() = user_id);
create policy "Users delete own fonts"
  on public.user_fonts for delete using (auth.uid() = user_id);

-- ─── captora-fonts storage bucket ──────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('captora-fonts', 'captora-fonts', false)
on conflict (id) do nothing;

drop policy if exists "Users access own fonts" on storage.objects;
create policy "Users access own fonts" on storage.objects
  for all using (
    bucket_id = 'captora-fonts'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'captora-fonts'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
