/**
 * Crash reporting — server side.
 *
 * Writes API-route failures into `public.app_events` using the
 * cookie-scoped server client, so the row is attributed to the
 * requesting user under RLS.
 *
 * Kept separate from `telemetry.ts` (the browser reporter) because this
 * module reaches `supabase/server.ts`, which imports `next/headers`.
 * Webpack follows even dynamic `import()` calls when the specifier is
 * statically resolvable, so a single combined module dragged
 * `next/headers` into the client bundle and failed the build. Import
 * this file only from route handlers and server components.
 */

import { buildRow, insertRows, type TelemetryPayload } from "./telemetry-core";

export type { TelemetryEvent, TelemetryPayload } from "./telemetry-core";

/**
 * Report a failure from an API route.
 *
 * Call it fire-and-forget (`void reportServerEvent(...)`) from a catch
 * block — the user's error response must not wait on, or be affected by,
 * a telemetry insert.
 */
export async function reportServerEvent(payload: TelemetryPayload): Promise<void> {
  try {
    const { createClient } = await import("./supabase/server");
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // No session means no RLS-valid row to write. That's fine: an
    // unauthenticated request can't have got far enough to fail in an
    // interesting way — every route auth-gates first.
    if (!user) return;

    await insertRows(supabase, [
      buildRow(payload, user.id, "server", {
        // Inlined at build time from the root package.json — see the
        // `env` block in web/next.config.js. `npm_package_version` is
        // not set for the standalone server, which is the only place
        // this code actually runs in production.
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
        platform: process.platform,
        arch: process.arch,
      }),
    ]);
  } catch (err) {
    console.warn(
      "[telemetry] reportServerEvent failed:",
      err instanceof Error ? err.message : err
    );
  }
}
