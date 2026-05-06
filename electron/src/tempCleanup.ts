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
      if (now - s.mtimeMs > maxAgeMs) {
        bytesFreed += s.size;
        await unlink(fullPath);
        removed++;
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
  // Initial sweep — catches files left over from previous run
  sweep(maxAgeMs).catch((err) => {
    console.warn("[tempCleanup] initial sweep failed:", err);
  });

  timer = setInterval(() => {
    sweep(maxAgeMs).catch((err) => {
      console.warn("[tempCleanup] sweep failed:", err);
    });
  }, ONE_HOUR_MS);

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
