-- Captora — persist the rest of the editor's per-project state.
--
-- Run this in your Supabase SQL Editor after `007_app_events.sql`.
--
-- Three pieces of editor state were held only in React and never written
-- anywhere. They were sent to /api/render at export time, so a render in
-- the same session looked correct — but closing the project and reopening
-- it silently discarded all of them:
--
--   line_styles  — per-line template picks (mixing templates in one video)
--   word_sizes   — per-word size tweaks from the captions list
--   user_breaks  — manually forced line breaks
--
-- These are exactly the fiddly, high-effort edits a user spends the most
-- time on, which made the loss especially expensive. `line_animations`
-- (migration 004) was already persisted; these three are its siblings and
-- follow the same jsonb-blob shape.
--
-- Key formats, for anyone reading the raw rows:
--   line_styles  {"<centisecond start>": "<style id>"}   e.g. {"142":"hormozi"}
--   word_sizes   {"<centisecond start>": <multiplier>}   e.g. {"142":1.25}
--   user_breaks  [<word index>, …]                        e.g. [7, 15, 22]
--
-- user_breaks is a JSON array rather than an object because the client
-- holds it as a Set<number>, and Sets are not JSON-serialisable — the
-- editor already converts to an array to send it to /api/render, so
-- storing the same array keeps one representation on the wire and at rest.

alter table public.projects
  add column if not exists line_styles jsonb not null default '{}'::jsonb,
  add column if not exists word_sizes  jsonb not null default '{}'::jsonb,
  add column if not exists user_breaks jsonb not null default '[]'::jsonb;

comment on column public.projects.line_styles is
  'Per-line template overrides: {"<centisecond start>": "<CaptionStyleId>"}';
comment on column public.projects.word_sizes is
  'Per-word size multipliers: {"<centisecond start>": <number>}';
comment on column public.projects.user_breaks is
  'Word indexes after which the captions grouper starts a new line: [<int>, …]';
