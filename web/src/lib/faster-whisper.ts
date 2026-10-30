/**
 * Local GPU transcription via faster-whisper (Python subprocess).
 *
 * Spawns `scripts/whisper_gpu.py` which loads Whisper-large-v3 onto the
 * NVIDIA GPU and runs inference in 5-10× realtime. Used as the highest-
 * priority provider when `FASTER_WHISPER_ENABLED` is set in env — falls
 * through to Sarvam / Groq / local-CPU-Whisper otherwise.
 *
 * Why a Python subprocess instead of a Node binding:
 *   - faster-whisper / CTranslate2 ship prebuilt CUDA wheels on PyPI; no
 *     CUDA toolkit install needed (just GPU drivers).
 *   - onnxruntime-node-gpu requires a separate CUDA toolkit + cuDNN dance
 *     on Windows that's much heavier than `pip install faster-whisper`.
 *   - The subprocess is short-lived per request — no long-running GPU
 *     daemon to manage.
 */

import { spawn } from "child_process";
import { resolve } from "path";
import type { WhisperResult, WhisperWord } from "./whisper";
import { WHISPER_ISO_CODE } from "./languages";

const PYTHON_CMD = process.env.FASTER_WHISPER_PYTHON || "python";
const MODEL_NAME = process.env.FASTER_WHISPER_MODEL || "large-v3";
const DEVICE = process.env.FASTER_WHISPER_DEVICE || "cuda";
const COMPUTE_TYPE = process.env.FASTER_WHISPER_COMPUTE_TYPE || "float16";
/**
 * Optional vocabulary hint passed to faster-whisper as `initial_prompt`.
 * Whisper biases its decoder toward tokens that appear in this string,
 * which is the single biggest accuracy boost for proper nouns / brand
 * names / domain jargon. Set in `.env.local`, e.g.:
 *   FASTER_WHISPER_INITIAL_PROMPT="QHT clinic, Haridwar, hair transplant, FUE, FUT, Tarun Vadhwan"
 * Without it, names get mangled into homophones ("QHT" → "qst",
 * "Haridwar" → "haridvar", "hair transplant" → "hera transplant").
 */
const INITIAL_PROMPT = process.env.FASTER_WHISPER_INITIAL_PROMPT || "";

// Resolve relative to the workspace root (`web/`'s parent).
const SCRIPT_PATH = resolve(process.cwd(), "..", "scripts", "whisper_gpu.py");

/**
 * Whisper accepts ISO 639-1 codes ("hi", "en", "es", ...). Map our
 * spokenLanguage values to those. Synthetic "hi-roman" uses Hindi audio
 * with Roman post-processing applied later by the router. Shared table —
 * see languages.ts.
 */
const ISO_CODE = WHISPER_ISO_CODE;

interface Options {
  filePath: string;
  spokenLanguage: string;
  translateToEnglish: boolean;
}

export function isFasterWhisperEnabled(): boolean {
  const flag = process.env.FASTER_WHISPER_ENABLED;
  return flag === "1" || flag === "true";
}

interface RawOutput {
  text: string;
  language: string;
  duration: number;
  words: Array<{ word: string; start: number; end: number }>;
}

export async function transcribeWithFasterWhisper(opts: Options): Promise<WhisperResult> {
  const args: string[] = [
    SCRIPT_PATH,
    opts.filePath,
    "--task", opts.translateToEnglish ? "translate" : "transcribe",
    "--model", MODEL_NAME,
    "--device", DEVICE,
    "--compute-type", COMPUTE_TYPE,
  ];

  // Translation mode auto-detects; for transcribe we pass the language hint.
  if (!opts.translateToEnglish) {
    const iso = ISO_CODE[opts.spokenLanguage];
    if (iso) {
      args.push("--language", iso);
    }
  }

  // Bias the decoder toward the user-configured vocabulary if any was
  // set via `FASTER_WHISPER_INITIAL_PROMPT`. Skipped silently when empty
  // so existing setups behave identically until the env var is added.
  if (INITIAL_PROMPT) {
    args.push("--initial-prompt", INITIAL_PROMPT);
  }

  const t0 = Date.now();
  console.log(`[faster-whisper] spawn ${PYTHON_CMD} ${SCRIPT_PATH} model=${MODEL_NAME} device=${DEVICE}`);

  return new Promise<WhisperResult>((resolveP, reject) => {
    const proc = spawn(PYTHON_CMD, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // GPU transcription runs 5-10x realtime, so even a long clinic
    // consultation finishes well inside this window. Without a timeout
    // here, a stuck CUDA driver / hung model download used to block the
    // whole /api/transcribe request until Next's own route ceiling (30
    // min) killed it — defeating the router's "fail fast, fall back to
    // the next provider" design for every provider after this one.
    const TIMEOUT_MS = 15 * 60_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`faster-whisper timed out after ${TIMEOUT_MS / 60_000}min`));
    }, TIMEOUT_MS);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      // Surface faster-whisper's progress lines live so the dev server log
      // shows "Detected language..." / VAD info instead of going silent.
      process.stderr.write(`[faster-whisper] ${chunk}`);
    });

    proc.on("error", (err) => {
      settle(() => reject(new Error(
        `faster-whisper spawn failed: ${err.message}. ` +
        `Verify Python is on PATH or set FASTER_WHISPER_PYTHON env var.`
      )));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`faster-whisper exit ${code}: ${stderr.slice(-400) || "(no stderr)"}`)));
        return;
      }
      let data: RawOutput;
      try {
        data = JSON.parse(stdout) as RawOutput;
      } catch {
        settle(() => reject(new Error(`faster-whisper produced non-JSON output: ${stdout.slice(0, 200)}`)));
        return;
      }

      const words: WhisperWord[] = (data.words ?? []).map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
      }));

      console.log(
        `[faster-whisper] ok in ${Date.now() - t0}ms — words=${words.length} duration=${data.duration}s lang=${data.language}`
      );

      settle(() => resolveP({
        task: opts.translateToEnglish ? "translate" : "transcribe",
        language: data.language || opts.spokenLanguage,
        duration: data.duration ?? 0,
        text: data.text ?? "",
        words,
      }));
    });
  });
}
