-- Captora — initial schema.
--
-- Run this in your Supabase project's SQL Editor (Dashboard → SQL Editor →
-- New query → paste → Run). Idempotent for the most part — safe to re-run
-- after small edits.
--
-- Tables:
--   profiles  — extends auth.users with display data
--   projects  — one row per Captora project (transcription + render state)
--
-- RLS is on by default; users only see/edit their own rows. The
-- `handle_new_user` trigger auto-creates a profile when someone signs up.

-- ─── profiles ────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id            uuid references auth.users(id) on delete cascade primary key,
  email         text,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users read own profile"   on public.profiles;
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users read own profile"
  on public.profiles for select using (auth.uid() = id);
create policy "Users update own profile"
  on public.profiles for update using (auth.uid() = id);

-- ─── projects ────────────────────────────────────────────────────────────
create table if not exists public.projects (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  title                    text not null,

  -- source media (uploaded file in Supabase Storage)
  source_path              text,                                       -- e.g. "<user_id>/<uuid>.mp3"
  source_ext               text,                                       -- ".mp3", ".mp4", …
  source_thumbnail         text,                                       -- data: URL or storage path
  media_kind               text not null default 'video' check (media_kind in ('video', 'audio')),

  -- language settings (from the Prepare Media modal)
  spoken_language          text not null,                              -- e.g. "hi-roman", "english"
  spoken_language_label    text not null,                              -- e.g. "Hinglish"
  writing_script           text not null default 'native' check (writing_script in ('native', 'roman')),
  writing_script_label     text not null,
  translate_to_english     boolean not null default false,

  -- transcription
  transcribe_provider      text,                                       -- "sarvam" / "groq" / "faster-whisper-gpu" / "local-whisper"
  transcript_words         jsonb not null default '[]'::jsonb,         -- WhisperWord[]
  transcript_text          text,
  duration_sec             real not null default 0,

  -- caption styling
  style_id                 text not null default 'captora-glow',
  style_overrides          jsonb not null default '{}'::jsonb,

  -- render
  render_status            text not null default 'idle' check (render_status in ('idle', 'rendering', 'rendered', 'failed')),
  render_url               text,
  rendered_at              timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists projects_user_id_created_at_idx
  on public.projects (user_id, created_at desc);

alter table public.projects enable row level security;

drop policy if exists "Users read own projects"   on public.projects;
drop policy if exists "Users insert own projects" on public.projects;
drop policy if exists "Users update own projects" on public.projects;
drop policy if exists "Users delete own projects" on public.projects;

create policy "Users read own projects"
  on public.projects for select using (auth.uid() = user_id);
create policy "Users insert own projects"
  on public.projects for insert with check (auth.uid() = user_id);
create policy "Users update own projects"
  on public.projects for update using (auth.uid() = user_id);
create policy "Users delete own projects"
  on public.projects for delete using (auth.uid() = user_id);

-- ─── triggers ────────────────────────────────────────────────────────────

-- Auto-create a profile row when someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Bump updated_at on every row update.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- ─── storage buckets ─────────────────────────────────────────────────────
-- Run once via SQL or create via Dashboard → Storage → New bucket.
-- All three are private; access is gated by RLS on `storage.objects`.

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('captora-source',     'captora-source',     false, 2147483648), -- 2 GB
  ('captora-renders',    'captora-renders',    false, 2147483648), -- 2 GB
  ('captora-thumbnails', 'captora-thumbnails', false, 524288)      -- 512 KB
on conflict (id) do nothing;

-- Storage RLS: users can only read/write paths prefixed with their user_id.
-- Layout convention enforced by client code: "<user_id>/<filename>".

drop policy if exists "Users access own source"     on storage.objects;
drop policy if exists "Users access own renders"    on storage.objects;
drop policy if exists "Users access own thumbnails" on storage.objects;

create policy "Users access own source" on storage.objects
  for all using (
    bucket_id = 'captora-source'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'captora-source'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users access own renders" on storage.objects
  for all using (
    bucket_id = 'captora-renders'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'captora-renders'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users access own thumbnails" on storage.objects
  for all using (
    bucket_id = 'captora-thumbnails'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'captora-thumbnails'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
