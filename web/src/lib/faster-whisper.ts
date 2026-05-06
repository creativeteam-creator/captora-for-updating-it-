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
 * with Roman post-processing applied later by the router.
 */
const ISO_CODE: Record<string, string> = {
  english: "en",       spanish: "es",      french: "fr",      german: "de",
  italian: "it",       portuguese: "pt",   dutch: "nl",       russian: "ru",
  ukrainian: "uk",     polish: "pl",       czech: "cs",       slovak: "sk",
  hungarian: "hu",     romanian: "ro",     greek: "el",       turkish: "tr",
  arabic: "ar",        hebrew: "he",       persian: "fa",     japanese: "ja",
  korean: "ko",        chinese: "zh",      cantonese: "yue",  vietnamese: "vi",
  thai: "th",          indonesian: "id",   malay: "ms",       tagalog: "tl",
  swedish: "sv",       danish: "da",       norwegian: "no",   finnish: "fi",
  hindi: "hi",         "hi-roman": "hi",   marathi: "mr",     bengali: "bn",
  tamil: "ta",         telugu: "te",       kannada: "kn",     malayalam: "ml",
  gujarati: "gu",      punjabi: "pa",      urdu: "ur",        nepali: "ne",
  sanskrit: "sa",      assamese: "as",     sinhala: "si",
};

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
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      // Surface faster-whisper's progress lines live so the dev server log
      // shows "Detected language..." / VAD info instead of going silent.
      process.stderr.write(`[faster-whisper] ${chunk}`);
    });

    proc.on("error", (err) => {
      reject(new Error(
        `faster-whisper spawn failed: ${err.message}. ` +
        `Verify Python is on PATH or set FASTER_WHISPER_PYTHON env var.`
      ));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`faster-whisper exit ${code}: ${stderr.slice(-400) || "(no stderr)"}`));
        return;
      }
      let data: RawOutput;
      try {
        data = JSON.parse(stdout) as RawOutput;
      } catch {
        reject(new Error(`faster-whisper produced non-JSON output: ${stdout.slice(0, 200)}`));
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

      resolveP({
        task: opts.translateToEnglish ? "translate" : "transcribe",
        language: data.language || opts.spokenLanguage,
        duration: data.duration ?? 0,
        text: data.text ?? "",
        words,
      });
    });
  });
}
