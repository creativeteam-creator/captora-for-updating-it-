# Captora — Supabase Setup

One-time steps to get Captora's backend wired up. ~10 minutes.

## 1. Create a Supabase project

1. Go to **[supabase.com](https://supabase.com)** → sign up (Google login OK)
2. **New Project** → pick a name (e.g. `captora-dev`)
3. Choose a strong **Database Password** (save it — you'll need it for direct DB access later)
4. Region: closest to you (Mumbai / Singapore for India)
5. Plan: **Free tier** is fine for dev (500 MB DB, 1 GB Storage, 50k monthly active users)
6. Wait ~2 minutes while the project provisions

## 2. Copy the API keys

Dashboard → **Settings** → **API**:

| Key | Where it goes |
|---|---|
| **Project URL** | `NEXT_PUBLIC_SUPABASE_URL` |
| **anon / public** | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| **service_role** | `SUPABASE_SERVICE_ROLE_KEY` (server only — keep secret) |

Paste them into `web/.env.local` (copy from `.env.local.example` if you haven't already).

## 3. Run the schema migration

Dashboard → **SQL Editor** → **New query** → paste the contents of
[`migrations/001_init.sql`](migrations/001_init.sql) → **Run**.

This creates:
- `profiles` table (extends Supabase Auth users)
- `projects` table (one row per Captora project)
- Row-level security policies (users only see their own data)
- Storage buckets: `captora-source`, `captora-renders`, `captora-thumbnails`
- Auto-create-profile trigger on signup
- Auto-update `updated_at` triggers

Verify: Dashboard → **Table Editor** should show `profiles` and `projects`.
**Storage** tab should show the three buckets.

Then run the later migrations in order:

```text
migrations/002_user_fonts.sql
migrations/003_raise_storage_limits.sql
migrations/004_line_animations.sql
migrations/005_set_2gb_source_limit.sql
```

`005_set_2gb_source_limit.sql` is the important one for large uploads. It sets
`captora-source` and `captora-renders` to a 2 GB per-file bucket limit.

## 4. Restart the web dev server

```powershell
npm run dev:web
```

The server will pick up the new env vars. Foundation is ready.

## What's next

This is **Phase A — Foundation**. The Supabase client wrappers exist
(`web/src/lib/supabase/client.ts` + `server.ts`) but the app still uses
localStorage. Subsequent phases will wire it up:

- **Phase B**: Signup / login pages, auth middleware, protected routes
- **Phase C**: Replace localStorage projects with Supabase queries; upload
  source media to Storage; persist render outputs
- **Phase D**: Plan / quota tracking, sharing, multi-device sync

## Schema notes

Each Captora project ties together transcription, styling, and render
state in a single row. The full life cycle:

```
upload → POST /api/transcribe → projects row inserted (status: idle)
       → captions edit → row updates (style_overrides, etc.)
       → POST /api/render → row.render_status = 'rendering'
                          → render finishes → status='rendered', render_url=…
       → user downloads from Storage signed URL
```

Storage layout convention (enforced by RLS):

```
captora-source/<user_id>/<project_id>.<ext>
captora-renders/<user_id>/<project_id>.mp4
captora-thumbnails/<user_id>/<project_id>.jpg
```

`(storage.foldername(name))[1]` policy check ensures users can only
read/write paths prefixed with their own UID.

## Free-tier limits to watch

| Resource | Free | When you'll hit it |
|---|---|---|
| Database | 500 MB | ~50,000 projects' metadata — far away |
| Storage | 1 GB | Free tier cannot store a single 2 GB file; use Pro/self-hosted storage for 2 GB uploads |
| Monthly Active Users | 50,000 | 🚀 |
| Egress / bandwidth | 5 GB | ~150 video downloads at 30 MB |
| Edge function invocations | 500k | Not used yet |

Upgrade to **Pro ($25/mo)** when you outgrow these — gets 8 GB DB, 100 GB
Storage, 250 GB egress.
