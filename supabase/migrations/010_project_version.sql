-- Optimistic-concurrency guard for the editor's autosave writes.
--
-- The editor's autosave effects each hold their own in-memory snapshot
-- of a jsonb column (line_animations, line_styles, word_sizes, ...) and
-- write the WHOLE snapshot back on every debounced save — there's no
-- merge, it's a full replace. With the same project open in two tabs
-- or two devices (easy for a small clinic team sharing an account),
-- the second tab's stale snapshot can silently overwrite whatever the
-- first tab just saved, with no error and no trace.
--
-- `version` gives the client something cheap and precision-safe to
-- condition each write on (`updated_at` has sub-millisecond precision
-- that doesn't round-trip cleanly through JS's millisecond-resolution
-- Date, which would make an equality check unreliable). The app-layer
-- fix (web/src/lib/projects.ts) conditions each UPDATE on the version
-- it last saw and bumps it by one; a write that no longer matches means
-- someone else saved first, and the app surfaces that instead of
-- silently losing the edit.
--
-- Written to fail soft: web/src/lib/projects.ts falls back to the old
-- unconditional update if this column doesn't exist yet, so running
-- this migration late doesn't break anything — it just means the
-- protection isn't active until it's applied.

alter table public.projects
  add column if not exists version integer not null default 1;
