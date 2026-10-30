/**
 * First-run capability detection.
 *
 * Captora ships as a single Windows installer that needs to run on
 * machines with very different setups:
 *   - Dev machine (Python 3.11 + faster-whisper + NVIDIA GPU)  → fastest
 *   - Office PC (no Python, no GPU, has internet)              → cloud
 *   - Offline laptop (no internet)                              → CPU Whisper
 *
 * Rather than bundling Python/CUDA (~3 GB extra), we *probe* on first
 * launch what's available, cache the result in `<userData>/capabilities.json`,
 * and pass runtime env overrides to the Next.js server so the
 * transcription router naturally skips paths that won't work.
 *
 * Re-probed every 7 days so users who install Python later automatically
 * upgrade to GPU mode without reinstalling Captora.
 */

import { exec } from "child_process";
import { app } from "electron";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const CAPABILITIES_FILE = "captora-capabilities.json";
const RECHECK_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface Capabilities {
  /** Path to a working Python interpreter (or null if none found). */
  pythonPath: string | null;
  /** True if `import faster_whisper` succeeds in `pythonPath`. */
  fasterWhisperAvailable: boolean;
  /** True if `nvidia-smi` succeeds (CUDA GPU present + drivers installed). */
  gpuAvailable: boolean;
  /** True if a basic outbound HTTPS check succeeded. */
  internetAvailable: boolean;
  /** When this probe was last run (ISO 8601). */
  lastChecked: string;
  /** Captora version when last probed (re-probe on upgrade). */
  appVersion: string;
  /**
   * True when at least one probe hit its timeout rather than cleanly
   * succeeding or failing. A timeout (a hung driver query, a slow DNS
   * resolution) used to be recorded identically to a genuine negative —
   * "no GPU", "no internet" — and then cached for a full 7 days with no
   * way to tell the two apart. `loadOrDetectCapabilities` treats a
   * cached result with this flag set as always-stale, so a transient
   * hang gets retried on the next launch instead of sticking around for
   * a week.
   */
  probeIncomplete: boolean;
}

type ProbeResult = "ok" | "failed" | "timeout";

/** Run a shell command; resolves "ok" (exit 0), "failed" (nonzero /
 *  error), or "timeout" (killed after `timeoutMs` — a hung process is
 *  NOT the same claim as a clean failure, and callers need to be able
 *  to tell them apart). */
function probeCommand(cmd: string, timeoutMs = 5000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = exec(cmd, { windowsHide: true }, (err) => {
      if (settled) return; // already resolved via the timeout branch
      settled = true;
      clearTimeout(timer);
      resolve(err ? "failed" : "ok");
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve("timeout");
    }, timeoutMs);
  });
}

/** Locate a usable Python — try a few common command names / paths.
 *  Returns the path plus whether any candidate merely timed out (as
 *  opposed to every candidate cleanly failing), so the caller can
 *  propagate that into `probeIncomplete`. */
async function findPythonPath(): Promise<{ path: string | null; incomplete: boolean }> {
  const candidates = [
    process.env.FASTER_WHISPER_PYTHON,
    "python",
    "python3",
    "python3.11",
    "py",
  ].filter((c): c is string => Boolean(c && c.trim()));

  let incomplete = false;
  for (const cmd of candidates) {
    // -c "" exits 0 only if the interpreter actually runs. `--version`
    // also works but Windows sometimes routes "py --version" through a
    // launcher that returns 0 even when no Python is installed.
    // `import sys` alone succeeds under Python 2 just as readily as
    // Python 3 — on a machine where a stray Python 2 shim is what
    // resolves first on PATH, this used to report pythonPath as "found"
    // even though faster-whisper (Python-3-only) can never actually run
    // under it. The exit-code check below fails the probe outright for
    // anything below 3.x instead of just downstream (via the later
    // `import faster_whisper` probe) reporting a misleadingly separate
    // "found Python but no faster-whisper" state.
    const result = await probeCommand(
      `${cmd} -c "import sys; sys.exit(0 if sys.version_info[0]>=3 else 1)"`
    );
    if (result === "ok") return { path: cmd, incomplete };
    if (result === "timeout") incomplete = true;
  }
  return { path: null, incomplete };
}

export async function detectCapabilities(): Promise<Capabilities> {
  console.log("[capabilities] probing system…");
  const { path: pythonPath, incomplete: pythonIncomplete } = await findPythonPath();

  let fasterWhisperAvailable = false;
  let fasterWhisperIncomplete = false;
  if (pythonPath) {
    const result = await probeCommand(
      `${pythonPath} -c "import faster_whisper"`,
      8000
    );
    fasterWhisperAvailable = result === "ok";
    fasterWhisperIncomplete = result === "timeout";
  }

  // `nvidia-smi` is only on PATH when NVIDIA drivers are installed
  // properly (regardless of Python). Quick 3s probe.
  const gpuResult = await probeCommand("nvidia-smi -L", 3000);
  const gpuAvailable = gpuResult === "ok";

  // Lightweight HTTPS reachability check — picks a Google domain
  // because Gemini/HuggingFace will be the most-hit external host
  // for cloud paths. `curl` ships with modern Windows.
  const netResult = await probeCommand(
    `curl -s -o NUL -w "%{http_code}" -m 4 https://generativelanguage.googleapis.com/v1beta/models | findstr /R "^[12345][0-9][0-9]$"`,
    6000
  );
  const internetAvailable = netResult === "ok";

  const caps: Capabilities = {
    pythonPath,
    fasterWhisperAvailable,
    gpuAvailable,
    internetAvailable,
    lastChecked: new Date().toISOString(),
    appVersion: app.getVersion(),
    probeIncomplete:
      pythonIncomplete ||
      fasterWhisperIncomplete ||
      gpuResult === "timeout" ||
      netResult === "timeout",
  };

  console.log("[capabilities]", caps);
  return caps;
}

/**
 * Read cached capabilities; re-probe if stale, missing, or from a
 * different Captora version. Always writes the latest result back.
 */
export async function loadOrDetectCapabilities(): Promise<Capabilities> {
  const userDataDir = app.getPath("userData");
  const filepath = join(userDataDir, CAPABILITIES_FILE);

  if (existsSync(filepath)) {
    try {
      const cached = JSON.parse(await readFile(filepath, "utf-8")) as Capabilities;
      const age = Date.now() - new Date(cached.lastChecked).getTime();
      // A cache written from a probe that timed out (rather than
      // cleanly resolving every check) is NOT trusted for the full
      // 7-day window — `cached.probeIncomplete` is undefined on files
      // written before this field existed, which is falsy and behaves
      // like "complete", preserving old cache behaviour for upgraders.
      if (
        age < RECHECK_AGE_MS &&
        cached.appVersion === app.getVersion() &&
        !cached.probeIncomplete
      ) {
        console.log(
          `[capabilities] using cache (age=${Math.round(age / 60000)}min, ` +
          `python=${cached.pythonPath ?? "no"}, fw=${cached.fasterWhisperAvailable}, ` +
          `gpu=${cached.gpuAvailable}, net=${cached.internetAvailable})`
        );
        return cached;
      }
      if (cached.probeIncomplete) {
        console.log("[capabilities] cached probe was incomplete (a check timed out) — re-probing");
      }
    } catch {
      // Corrupted file — fall through to re-detect.
    }
  }

  const fresh = await detectCapabilities();
  try {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(filepath, JSON.stringify(fresh, null, 2));
  } catch (err) {
    console.warn("[capabilities] failed to persist cache:", err);
  }
  return fresh;
}

/**
 * Force a fresh probe and overwrite the cache, bypassing the 7-day
 * window entirely. Exposed to the renderer via the
 * `captora:recheckCapabilities` IPC handler (main.ts) for a user who
 * just installed Python/faster-whisper and doesn't want to wait out
 * the cache — previously the only way to pick that up sooner than 7
 * days was an app version bump.
 *
 * Does NOT change the already-running embedded Next.js server's
 * environment — those env vars were fixed at spawn time
 * (nextServer.ts). The caller is expected to tell the user to restart
 * Captora to actually pick up the new capabilities; this only makes
 * sure that restart sees a fresh result instead of the same stale one.
 */
export async function recheckCapabilities(): Promise<Capabilities> {
  const userDataDir = app.getPath("userData");
  const filepath = join(userDataDir, CAPABILITIES_FILE);
  const fresh = await detectCapabilities();
  try {
    await mkdir(userDataDir, { recursive: true });
    await writeFile(filepath, JSON.stringify(fresh, null, 2));
  } catch (err) {
    console.warn("[capabilities] failed to persist cache:", err);
  }
  return fresh;
}

/**
 * Translate detected capabilities into env overrides for the Next.js
 * server. Returning an env-shape object means we can spread it directly
 * into the spawn() call — no plumbing changes elsewhere.
 *
 * Logic:
 *   - faster-whisper unavailable → force FASTER_WHISPER_ENABLED=0 so
 *     the router doesn't waste a Python spawn attempt every transcription.
 *   - python found at a non-default path → expose it via FASTER_WHISPER_PYTHON.
 *
 * (Internet & GPU don't need overrides — they're handled by the in-process
 * fallback chain naturally.)
 */
export function capabilitiesToEnv(caps: Capabilities): Record<string, string> {
  const env: Record<string, string> = {};
  if (!caps.fasterWhisperAvailable) {
    env.FASTER_WHISPER_ENABLED = "0";
  } else if (caps.pythonPath && caps.pythonPath !== "python") {
    env.FASTER_WHISPER_PYTHON = caps.pythonPath;
  }
  return env;
}
