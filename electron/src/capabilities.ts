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
}

/** Run a shell command and resolve true if exit code is 0 within `timeoutMs`. */
function probeCommand(cmd: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = exec(cmd, { windowsHide: true }, (err) => {
      if (timer) clearTimeout(timer);
      resolve(!err);
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(false);
    }, timeoutMs);
  });
}

/** Locate a usable Python — try a few common command names / paths. */
async function findPythonPath(): Promise<string | null> {
  const candidates = [
    process.env.FASTER_WHISPER_PYTHON,
    "python",
    "python3",
    "python3.11",
    "py",
  ].filter((c): c is string => Boolean(c && c.trim()));

  for (const cmd of candidates) {
    // -c "" exits 0 only if the interpreter actually runs. `--version`
    // also works but Windows sometimes routes "py --version" through a
    // launcher that returns 0 even when no Python is installed.
    if (await probeCommand(`${cmd} -c "import sys"`)) {
      return cmd;
    }
  }
  return null;
}

export async function detectCapabilities(): Promise<Capabilities> {
  console.log("[capabilities] probing system…");
  const pythonPath = await findPythonPath();

  let fasterWhisperAvailable = false;
  if (pythonPath) {
    fasterWhisperAvailable = await probeCommand(
      `${pythonPath} -c "import faster_whisper"`,
      8000
    );
  }

  // `nvidia-smi` is only on PATH when NVIDIA drivers are installed
  // properly (regardless of Python). Quick 3s probe.
  const gpuAvailable = await probeCommand("nvidia-smi -L", 3000);

  // Lightweight HTTPS reachability check — picks a Google domain
  // because Gemini/HuggingFace will be the most-hit external host
  // for cloud paths. `curl` ships with modern Windows.
  const internetAvailable = await probeCommand(
    `curl -s -o NUL -w "%{http_code}" -m 4 https://generativelanguage.googleapis.com/v1beta/models | findstr /R "^[12345][0-9][0-9]$"`,
    6000
  );

  const caps: Capabilities = {
    pythonPath,
    fasterWhisperAvailable,
    gpuAvailable,
    internetAvailable,
    lastChecked: new Date().toISOString(),
    appVersion: app.getVersion(),
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
      if (age < RECHECK_AGE_MS && cached.appVersion === app.getVersion()) {
        console.log(
          `[capabilities] using cache (age=${Math.round(age / 60000)}min, ` +
          `python=${cached.pythonPath ?? "no"}, fw=${cached.fasterWhisperAvailable}, ` +
          `gpu=${cached.gpuAvailable}, net=${cached.internetAvailable})`
        );
        return cached;
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
