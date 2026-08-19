/**
 * Crash reporting — shared core.
 *
 * Types and pure helpers used by BOTH the browser reporter
 * (`telemetry.ts`) and the server reporter (`telemetry-server.ts`).
 * Deliberately imports nothing from `supabase/server` or `supabase/client`.
 *
 * Why the split exists: `supabase/server.ts` imports `next/headers`, and
 * webpack follows even a dynamic `import()` when it can resolve the
 * specifier statically. A single telemetry module that touched both
 * clients therefore dragged `next/headers` into the browser bundle and
 * failed the build. Keeping the shared logic here — free of any Supabase
 * import — means each side pulls in only the client it can actually use.
 *
 * Everything writes into `public.app_events`
 * (supabase/migrations/007_app_events.sql).
 */

/** Stable, low-cardinality grouping keys. Add to this union rather than
 *  passing ad-hoc strings — the dashboard groups on it, and free-form
 *  values turn "top failures" into a list of one-offs. */
export type TelemetryEvent =
  | "render.failed"
  | "transcribe.failed"
  | "retranscribe.failed"
  | "upload.failed"
  | "ui.uncaught-error"
  | "ui.unhandled-rejection"
  | "main.uncaught-exception"
  | "main.unhandled-rejection"
  | "main.renderer-gone"
  | "main.child-process-gone"
  | "main.next-server-exited"
  | "update.failed";

export interface TelemetryPayload {
  event: TelemetryEvent;
  message: string;
  level?: "error" | "warn" | "info";
  stack?: string;
  /** Structured detail for triage. Keep it small and non-sensitive. */
  context?: Record<string, unknown>;
  /** Defaults to now. Set explicitly for spooled events, whose failure
   *  time and upload time can be days apart. */
  occurredAt?: string;
}

/** One line as written by electron/src/eventSpool.ts. */
export interface SpooledEvent {
  id: string;
  occurredAt: string;
  level: "error" | "warn" | "info";
  source: string;
  event: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  appVersion: string;
  platform: string;
  arch: string;
}

/** Shape of a row in public.app_events. */
export interface AppEventRow {
  id: string;
  user_id: string;
  occurred_at: string;
  level: string;
  source: string;
  event: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  app_version: string | null;
  platform: string | null;
  arch: string | null;
}

/** Postgres columns are text; these caps stop one giant stack trace from
 *  bloating the table (and the insert). */
export const MAX_MESSAGE = 4000;
export const MAX_STACK = 12000;

/** Keys we strip out of `context` no matter who passes them. Defence in
 *  depth — nothing should be putting a key here in the first place, but
 *  a crash payload is exactly the kind of place a secret leaks by
 *  accident (e.g. spreading a whole request body into context). */
const SENSITIVE_KEY = /(key|token|secret|password|authorization|cookie)/i;

export function sanitiseContext(
  context: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!context) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    // Keep values JSON-safe and bounded. Objects go through JSON so a
    // stray class instance or circular ref can't break the insert.
    if (v === null || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (typeof v === "string") {
      out[k] = v.slice(0, 1000);
    } else {
      try {
        out[k] = JSON.parse(JSON.stringify(v));
      } catch {
        out[k] = String(v).slice(0, 1000);
      }
    }
  }
  return out;
}

/**
 * UUID that works in both runtimes. `globalThis.crypto.randomUUID` is
 * present in Node 19+ and in browsers on secure origins (which includes
 * localhost, so the Electron shell qualifies).
 *
 * Deliberately no `import { randomUUID } from "crypto"` fallback — this
 * module is reachable from client components, and a bare node:crypto
 * import breaks the browser bundle. The random-hex fallback below is only
 * reached on exotic runtimes, and its only job is to be unique enough for
 * the table's primary key.
 */
export function makeId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return (
    `${Date.now().toString(16)}-` +
    `${Math.random().toString(16).slice(2, 10)}-` +
    `${Math.random().toString(16).slice(2, 14)}`
  );
}

export function buildRow(
  payload: TelemetryPayload,
  userId: string,
  source: "server" | "renderer" | "electron-main",
  env: { appVersion?: string; platform?: string; arch?: string }
): AppEventRow {
  return {
    id: makeId(),
    user_id: userId,
    occurred_at: payload.occurredAt ?? new Date().toISOString(),
    level: payload.level ?? "error",
    source,
    event: payload.event,
    message: String(payload.message ?? "").slice(0, MAX_MESSAGE),
    stack: payload.stack ? String(payload.stack).slice(0, MAX_STACK) : null,
    context: sanitiseContext(payload.context),
    app_version: env.appVersion ?? null,
    platform: env.platform ?? null,
    arch: env.arch ?? null,
  };
}

/**
 * Insert rows, ignoring ones whose ID already exists.
 *
 * `ignoreDuplicates` is what makes retries safe: a flush that uploaded
 * half its batch before the network dropped can re-run the whole batch
 * without creating duplicate reports.
 */
export async function insertRows(
  // The Database generic isn't generated for this project, so the typed
  // client doesn't know about app_events. Runtime shape is what matters.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  rows: AppEventRow[]
): Promise<boolean> {
  if (rows.length === 0) return true;
  const { error } = await supabase
    .from("app_events")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  if (error) {
    console.warn("[telemetry] insert failed:", error.message);
    return false;
  }
  return true;
}
