/**
 * Crash / diagnostic event spool for the Electron main process.
 *
 * The main process has no Supabase client and no user session — it can't
 * report anything itself. Worse, the moments we most want to capture
 * (main-process uncaught exception, renderer process gone, the embedded
 * Next.js server dying) are exactly the moments when the network path
 * through the renderer is unavailable.
 *
 * So main writes events to an append-only JSONL file on disk, and the
 * renderer drains that file into Supabase on its next successful boot.
 * A crash today shows up in the dashboard the next time the user opens
 * Captora and signs in. That's a delay, not a loss — which beats today's
 * situation of "the log sits on the user's PC forever and nobody knows".
 *
 * Design notes:
 *   - Writes are SYNCHRONOUS. An uncaught-exception handler has
 *     milliseconds before the process dies; an async write would be lost.
 *   - Each event carries a client-generated UUID so a drain that fails
 *     halfway can safely re-run — the insert dedupes on primary key.
 *   - The file is capped. A crash loop must not fill the user's disk.
 */

import { app } from "electron";
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";

const SPOOL_FILE = "captora-events.jsonl";

/** Beyond this the spool is truncated to its newest half. ~1000 events. */
const MAX_SPOOL_BYTES = 512 * 1024;

/** Hard cap on what one drain returns, so a pathological spool can't
 *  stall the renderer's boot with a giant insert. */
const MAX_DRAIN_EVENTS = 200;

export type SpoolLevel = "error" | "warn" | "info";

export interface SpoolEvent {
  /** Client-generated so re-drains dedupe against the table's PK. */
  id: string;
  occurredAt: string;
  level: SpoolLevel;
  /** Where it came from — 'electron-main' for everything in this file. */
  source: string;
  /** Stable dotted key for grouping, e.g. "main.uncaught-exception". */
  event: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  appVersion: string;
  platform: string;
  arch: string;
}

function spoolPath(): string {
  return join(app.getPath("userData"), SPOOL_FILE);
}

/**
 * Keep the spool bounded. When it grows past MAX_SPOOL_BYTES we drop the
 * older half rather than the whole file — a crash loop's FIRST occurrence
 * is usually the informative one, but the most recent ones tell us
 * whether it's still happening, and keeping the tail is simpler and
 * cheaper than reasoning about which half matters more.
 */
function trimIfOversized(path: string): void {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size <= MAX_SPOOL_BYTES) return;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length / 2));
    writeFileSync(path, keep.join("\n") + "\n", "utf8");
  } catch {
    /* best-effort — never let housekeeping break the caller */
  }
}

/**
 * Append one event to the spool. Safe to call from a crash handler:
 * synchronous, swallows its own errors, never throws.
 */
export function recordEvent(
  event: string,
  message: string,
  opts: {
    level?: SpoolLevel;
    stack?: string;
    context?: Record<string, unknown>;
  } = {}
): void {
  try {
    const entry: SpoolEvent = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      level: opts.level ?? "error",
      source: "electron-main",
      event,
      message: String(message).slice(0, 4000),
      stack: opts.stack ? String(opts.stack).slice(0, 12000) : undefined,
      context: opts.context,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    };
    const path = spoolPath();
    trimIfOversized(path);
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* the spool is best-effort by definition */
  }
}

/**
 * Read every spooled event and clear the file. Called once per app boot
 * from the renderer (via IPC) after the user is authenticated.
 *
 * The file is deleted BEFORE the caller uploads, deliberately: if the
 * upload fails, the caller still holds the array and can retry within the
 * session, and we'd rather lose a crash report than re-report the same
 * crash on every launch forever. Malformed lines are skipped rather than
 * failing the whole drain.
 */
export function drainEvents(): SpoolEvent[] {
  const path = spoolPath();
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    try {
      unlinkSync(path);
    } catch {
      /* if we can't delete it, the next drain re-sends — dedupe covers us */
    }
    const events: SpoolEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SpoolEvent);
      } catch {
        /* skip a torn line — a sync append interrupted by process death */
      }
    }
    return events.slice(-MAX_DRAIN_EVENTS);
  } catch {
    return [];
  }
}
