/**
 * Crash reporting — browser side.
 *
 * Writes failures into `public.app_events` using the anon-key browser
 * client, so every row lands under the signed-in user's RLS scope.
 *
 * Server-side reporting lives in `telemetry-server.ts`; the shared types
 * and helpers live in `telemetry-core.ts`. They are separate modules
 * because `supabase/server.ts` imports `next/headers`, which cannot be
 * pulled into the client bundle — see the note at the top of
 * telemetry-core.ts.
 *
 * Two entry points here:
 *   reportClientEvent()  — an error that happened in the UI right now.
 *   flushSpooledEvents() — crashes the Electron main process wrote to
 *                          disk while it had no session (see
 *                          electron/src/eventSpool.ts), uploaded under
 *                          the now-signed-in user.
 *
 * Non-negotiables, because a reporting system that breaks the app it
 * reports on is worse than no reporting system:
 *   - Every function swallows its own errors and returns void/number.
 *   - Nothing here is ever awaited on a critical path.
 *   - No media contents and no API keys go into `context`. Ever.
 */

import {
  buildRow,
  insertRows,
  sanitiseContext,
  MAX_MESSAGE,
  MAX_STACK,
  type SpooledEvent,
  type TelemetryPayload,
  type AppEventRow,
} from "./telemetry-core";

export type {
  TelemetryEvent,
  TelemetryPayload,
  SpooledEvent,
} from "./telemetry-core";

/**
 * Report a failure from the browser UI. Fire-and-forget — call it as
 * `void reportClientEvent(...)` from a catch block or error handler.
 */
export async function reportClientEvent(payload: TelemetryPayload): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    const { createClient } = await import("./supabase/client");
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // No session, no RLS-valid row. Errors on the login screen are lost
    // by design — the alternative is an unauthenticated write path, and
    // that's a spam vector pointed at our own database.
    if (!user) return;

    await insertRows(supabase, [
      buildRow(payload, user.id, "renderer", {
        // Inlined at build time from the root package.json — see the
        // `env` block in web/next.config.js.
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
        platform: navigator.platform,
        arch: undefined,
      }),
    ]);
  } catch (err) {
    console.warn(
      "[telemetry] reportClientEvent failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Upload crashes the Electron main process recorded while it had no
 * Supabase session — main-process exceptions, renderer crashes, the
 * embedded Next.js server dying.
 *
 * Called once per boot, after sign-in. Returns how many rows were
 * accepted, mostly so the caller can log it.
 *
 * Note on attribution: the spool has no user identity, so events are
 * attributed to whoever is signed in when the drain runs. On a
 * single-user desktop install that's the right person. On a shared
 * machine it may not be — the platform/version/stack fields are what
 * actually matter for triage, not the user column.
 */
export async function flushSpooledEvents(events: SpooledEvent[]): Promise<number> {
  try {
    if (!events || events.length === 0) return 0;
    if (typeof window === "undefined") return 0;

    const { createClient } = await import("./supabase/client");
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return 0;

    const rows: AppEventRow[] = events.map((e) => ({
      // Reuse the spool's own ID so a partial upload can be retried
      // without duplicating rows.
      id: e.id,
      user_id: user.id,
      occurred_at: e.occurredAt,
      level: e.level ?? "error",
      // The spool only ever writes main-process events; pin the value
      // rather than trusting the file, which sits on disk the user can edit.
      source: "electron-main",
      event: e.event,
      message: String(e.message ?? "").slice(0, MAX_MESSAGE),
      stack: e.stack ? String(e.stack).slice(0, MAX_STACK) : null,
      context: sanitiseContext(e.context),
      app_version: e.appVersion ?? null,
      platform: e.platform ?? null,
      arch: e.arch ?? null,
    }));

    const ok = await insertRows(supabase, rows);
    if (ok) {
      console.log(
        `[telemetry] flushed ${rows.length} spooled event(s) from the desktop shell`
      );
      return rows.length;
    }
    return 0;
  } catch (err) {
    console.warn(
      "[telemetry] flushSpooledEvents failed:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}
