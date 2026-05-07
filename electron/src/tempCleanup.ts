/**
 * Auto-cleanup of the local sessions folder. Source videos uploaded
 * by the user land in `<userData>/sessions/` so the editor can run
 * Whisper + Remotion on them without uploading to Supabase first.
 * Without periodic cleanup that folder grows unbounded — each 30-min
 * 1080p clip is ~800MB.
 *
 * Policy: anything older than 12 hours by mtime gets deleted. Sweeps
 * once on startup and then every hour. Runs silently — failures are
 * logged but never block the app. Renders folder is left alone; users
 * may want to keep their finished videos around indefinitely.
 */

import { readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { app } from "electron";

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

async function sweep(maxAgeMs: number): Promise<void> {
  const dir = join(app.getPath("userData"), "sessions");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Folder doesn't exist yet — nothing to clean
    return;
  }

  const now = Date.now();
  let removed = 0;
  let bytesFreed = 0;

  for (const name of entries) {
    const fullPath = join(dir, name);
    try {
      const s = await stat(fullPath);
      // Use the NEWEST of mtime / ctime / birthtime to decide age.
      // mtime alone is unreliable because Node's copyFile preserves
      // the source's mtime — a freshly-copied file from an old source
      // would otherwise get deleted on the very first sweep. Looking
      // at MAX(mtime, ctime, birthtime) catches the actual moment the
      // file appeared on this disk regardless of where it came from.
      const newest = Math.max(
        s.mtimeMs,
        s.ctimeMs,
        s.birthtimeMs || 0
      );
      const ageMs = now - newest;
      if (ageMs > maxAgeMs) {
        bytesFreed += s.size;
        await unlink(fullPath);
        removed++;
        console.log(
          `[tempCleanup] removed ${name} (age ${(ageMs / 3600_000).toFixed(1)}h, ${(s.size / 1024 / 1024).toFixed(1)} MB)`
        );
      }
    } catch {
      // File may have vanished mid-sweep; ignore
    }
  }

  if (removed > 0) {
    const mb = (bytesFreed / 1024 / 1024).toFixed(1);
    console.log(`[tempCleanup] removed ${removed} stale files (${mb} MB freed)`);
  }
}

/**
 * Start the cleanup timer. Returns a stop function so the caller
 * (main.ts) can clear it on app quit.
 */
export function startTempCleanup(maxAgeMs = TWELVE_HOURS_MS): () => void {
  // Initial sweep is delayed 30s. Reason: a user who launches the
  // app and IMMEDIATELY drops a video could otherwise race the
  // initial sweep — file gets copied, sweep fires, file (with
  // possibly old inherited mtime, even with our utimes touch) gets
  // unlinked before /api/transcribe reads it. Waiting 30s gives any
  // immediate drop time to fully copy + transcribe before sweeping.
  const initialDelay = setTimeout(() => {
    sweep(maxAgeMs).catch((err) => {
      console.warn("[tempCleanup] initial sweep failed:", err);
    });
  }, 30_000);

  timer = setInterval(() => {
    sweep(maxAgeMs).catch((err) => {
      console.warn("[tempCleanup] sweep failed:", err);
    });
  }, ONE_HOUR_MS);

  return () => {
    clearTimeout(initialDelay);
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
