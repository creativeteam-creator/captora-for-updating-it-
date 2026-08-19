-- Captora — crash reporting / diagnostic telemetry.
--
-- Run this in your Supabase SQL Editor after `006_user_api_keys.sql`.
--
-- Problem this solves: when an export fails on a user's machine, the only
-- record is `captora.log` on their PC. Nobody sees it unless that user
-- happens to complain. Three of ten users could be failing every render
-- and the team would find out weeks later, by word of mouth.
--
-- This table is the destination for:
--   - server-side failures in /api/render and /api/transcribe
--   - uncaught errors and unhandled promise rejections in the browser UI
--   - Electron main-process crashes, renderer crashes, and embedded-server
--     deaths, which are spooled to disk and drained on the next boot
--     (see electron/src/eventSpool.ts)
--
-- Deliberately NOT analytics. No page views, no feature usage, no funnels.
-- Only things that went wrong, plus the context needed to fix them.

-- ─── app_events ──────────────────────────────────────────────────────────
create table if not exists public.app_events (
  -- Client-generated. Lets a retried upload dedupe against a partially
  -- succeeded one instead of double-reporting the same crash.
  id           uuid primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,

  -- When the failure actually happened. Distinct from created_at, which
  -- is when it reached us — a spooled Electron crash can arrive hours or
  -- days later, and conflating the two would make the timeline lie.
  occurred_at  timestamptz not null default now(),

  level        text not null default 'error'
                 check (level in ('error', 'warn', 'info')),
  -- Which process produced it.
  source       text not null
                 check (source in ('server', 'renderer', 'electron-main')),
  -- Stable dotted key for grouping, e.g. 'render.failed',
  -- 'transcribe.failed', 'main.uncaught-exception'. Keep the cardinality
  -- low — the message field is where the variable detail belongs.
  event        text not null,
  message      text not null default '',
  stack        text,
  -- Free-form structured detail: projectId, style, provider, duration,
  -- exit code, etc. Never put media contents or API keys here.
  context      jsonb not null default '{}'::jsonb,

  app_version  text,
  platform     text,
  arch         text,

  created_at   timestamptz not null default now()
);

-- Primary read pattern for the dashboard: "what broke recently".
create index if not exists app_events_occurred_at_idx
  on public.app_events (occurred_at desc);

-- Second read pattern: "how often does THIS failure happen".
create index if not exists app_events_event_occurred_at_idx
  on public.app_events (event, occurred_at desc);

-- Third: "show me everything one user hit" when triaging a complaint.
create index if not exists app_events_user_id_occurred_at_idx
  on public.app_events (user_id, occurred_at desc);

alter table public.app_events enable row level security;

drop policy if exists "Users insert own events" on public.app_events;
drop policy if exists "Users read own events"   on public.app_events;

-- Insert-only from the client, scoped to the signed-in user. There is
-- deliberately no update or delete policy: a crash report should not be
-- editable or erasable by the process that produced it.
create policy "Users insert own events"
  on public.app_events for insert with check (auth.uid() = user_id);

-- Users can read their own events (useful for an in-app "recent errors"
-- view later). Team-wide triage goes through the service role, which
-- bypasses RLS.
create policy "Users read own events"
  on public.app_events for select using (auth.uid() = user_id);

-- ─── retention ───────────────────────────────────────────────────────────
-- Crash reports lose value fast and this table only grows. Call this from
-- a scheduled job (Supabase Dashboard → Database → Cron), or just run it
-- by hand every few months:
--
--   select public.prune_app_events();
--
create or replace function public.prune_app_events(older_than interval default interval '90 days')
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  removed bigint;
begin
  delete from public.app_events where occurred_at < now() - older_than;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- ─── triage helpers ──────────────────────────────────────────────────────
-- Paste these into the SQL Editor when you want to know what's breaking.
--
-- Top failures in the last 7 days, with how many distinct users hit each:
--
--   select event,
--          count(*)                as occurrences,
--          count(distinct user_id) as users_affected,
--          max(occurred_at)        as last_seen
--   from public.app_events
--   where level = 'error' and occurred_at > now() - interval '7 days'
--   group by event
--   order by users_affected desc, occurrences desc;
--
-- Are exports actually failing, and on which app version?
--
--   select app_version, platform, count(*)
--   from public.app_events
--   where event = 'render.failed' and occurred_at > now() - interval '30 days'
--   group by app_version, platform
--   order by count(*) desc;
--
-- Full detail for one failure type:
--
--   select occurred_at, user_id, message, context
--   from public.app_events
--   where event = 'render.failed'
--   order by occurred_at desc
--   limit 50;
