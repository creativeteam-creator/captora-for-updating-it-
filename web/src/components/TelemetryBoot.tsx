"use client";

/**
 * Mounted once at the app root. Does two jobs, both invisible to the user:
 *
 *   1. Catches errors the UI would otherwise swallow — uncaught exceptions
 *      and unhandled promise rejections — and reports them. A React render
 *      crash or a rejected fetch used to leave nothing behind but a red
 *      line in a console nobody has open.
 *
 *   2. Uploads crash reports the Electron main process spooled to disk
 *      while it had no Supabase session: startup failures, main-process
 *      exceptions, renderer crashes, embedded-server deaths. Those are
 *      precisely the failures where "the app just doesn't work" and the
 *      evidence never left the user's machine.
 *
 * Renders nothing. Every path here is best-effort and swallows its own
 * errors — a telemetry component that can break the app is worse than no
 * telemetry component.
 */

import { useEffect } from "react";
import { drainDesktopEvents } from "@/lib/electron-bridge";
import { createClient } from "@/lib/supabase/client";
import {
  flushSpooledEvents,
  reportClientEvent,
  type SpooledEvent,
} from "@/lib/telemetry";

/**
 * Guards against reporting the same error dozens of times. A render loop
 * or an interval that throws can fire hundreds of identical errors per
 * minute; without this, one bad build would flood the table and hide
 * everything else.
 */
const MAX_REPORTS_PER_SESSION = 25;

export function TelemetryBoot() {
  useEffect(() => {
    let reportCount = 0;
    const seen = new Set<string>();

    /** Report once per distinct message, up to a session cap. */
    const reportOnce = (
      event: "ui.uncaught-error" | "ui.unhandled-rejection",
      message: string,
      stack: string | undefined,
      context: Record<string, unknown>
    ) => {
      const fingerprint = `${event}::${message}`;
      if (seen.has(fingerprint)) return;
      if (reportCount >= MAX_REPORTS_PER_SESSION) return;
      seen.add(fingerprint);
      reportCount++;
      void reportClientEvent({ event, message, stack, context });
    };

    const onError = (e: ErrorEvent) => {
      reportOnce("ui.uncaught-error", e.message || "Unknown error", e.error?.stack, {
        // `filename` is the bundle chunk — combined with the line/column
        // it's enough to find the call site in a source map.
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        // Which screen the user was on. Query string is stripped: it can
        // carry auth tokens on the Supabase callback route.
        path: window.location.pathname,
      });
    };

    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const message =
        reason instanceof Error ? reason.message : String(reason ?? "Unknown rejection");
      reportOnce(
        "ui.unhandled-rejection",
        message,
        reason instanceof Error ? reason.stack : undefined,
        { path: window.location.pathname }
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    // ── Drain the desktop shell's crash spool ────────────────────────
    // Order matters here. drainDesktopEvents() CLEARS the spool, and
    // flushSpooledEvents() silently drops everything when there's no
    // signed-in user. Draining first and asking about auth second would
    // therefore destroy every crash report belonging to a user who
    // happens to be sitting on the login screen — which, for a
    // startup-crash report, is exactly who they usually are.
    //
    // So: wait for a session, THEN drain. On a cold launch the session
    // rehydrates from cookies a moment after mount, and on a genuine
    // logged-out start the drain simply waits for the sign-in that
    // follows.
    let drained = false;
    const supabase = createClient();

    const drainOnce = async () => {
      if (drained) return;
      drained = true;
      try {
        const events = (await drainDesktopEvents()) as SpooledEvent[];
        if (events.length === 0) return;
        await flushSpooledEvents(events);
      } catch {
        /* best-effort */
      }
    };

    // Case 1: already signed in when the app opens (the common case).
    void supabase.auth
      .getUser()
      .then(({ data }) => {
        if (data.user) void drainOnce();
      })
      .catch(() => {
        /* best-effort */
      });

    // Case 2: signed out at launch — drain as soon as they sign in.
    const { data: authSub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) void drainOnce();
    });

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      authSub.subscription.unsubscribe();
    };
  }, []);

  return null;
}
