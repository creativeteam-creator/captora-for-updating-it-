-- Per-line entrance-animation overrides for projects.
--
-- Stored as JSONB so the editor and renderer can read/write a flat
-- `Record<centisecondKey, variantName>` without a separate join table.
-- Default `'{}'::jsonb` so existing rows behave exactly as before
-- (empty map → composition cycles entrance variants automatically).
--
-- Run once in Supabase Dashboard → SQL Editor.

alter table public.projects
  add column if not exists line_animations jsonb not null default '{}'::jsonb;
