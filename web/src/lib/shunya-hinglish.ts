/**
 * Hinglish transcription via shunyalabs/zero-stt-hinglish.
 *
 * This is the highest-priority provider for `spokenLanguage === "hi-roman"`.
 * Unlike the Whisper + romanization chain (which does Hindi → Devanagari →
 * optitrans → polishRomanHindi), this model was fine-tuned natively on
 * code-switched Hindi+English speech and outputs Roman Hinglish directly —
 * the same technique used by Kalakar's captioning backend.
 *
 * Enable in `.env.local`:
 *   SHUNYA_HINGLISH_ENABLED=1
 *   SHUNYA_HINGLISH_PYTHON=python        # or full path
 *   SHUNYA_HINGLISH_MODEL=shunyalabs/zero-stt-hinglish
 *
 * Install Python deps (one-time):
 *   pip install torch transformers librosa soundfile
 *   # For GPU (optional, ~5x faster):
 *   pip install torch --index-url https://download.pytorch.org/whl/cu121
 */

import { spawn } from "child_process";
import { resolve } from "path";
import type { WhisperResult, WhisperWord } from "./whisper";

const PYTHON_CMD   = process.env.SHUNYA_HINGLISH_PYTHON   || "python";
const MODEL_NAME   = process.env.SHUNYA_HINGLISH_MODEL    || "shunyalabs/zero-stt-hinglish";
const DEVICE       = process.env.SHUNYA_HINGLISH_DEVICE   || "auto";
/**
 * Same vocabulary-bias hint as faster-whisper — feeds the Shunya model's
 * word-list post-processor with preferred spellings for brand names.
 * Falls back to FASTER_WHISPER_INITIAL_PROMPT so clinics that already set
 * that variable get the same benefit without a new env var.
 */
const INITIAL_PROMPT =
  process.env.SHUNYA_HINGLISH_INITIAL_PROMPT ||
  process.env.FASTER_WHISPER_INITIAL_PROMPT  ||
  "";

// Resolve relative to workspace root (parent of `web/`)
const SCRIPT_PATH = resolve(process.cwd(), "..", "scripts", "shunya_hinglish.py");

export function isShunyaHinglishEnabled(): boolean {
  const flag = process.env.SHUNYA_HINGLISH_ENABLED;
  return flag === "1" || flag === "true";
}

interface RawOutput {
  text: string;
  language: string;
  duration: number;
  words: Array<{ word: string; start: number; end: number }>;
}

interface Options {
  filePath: string;
}

/**
 * Spawn `shunya_hinglish.py` and parse its JSON result.
 * Rejects if the script exits non-zero or produces invalid JSON.
 */
export async function transcribeWithShunyaHinglish(
  opts: Options
): Promise<WhisperResult> {
  const args: string[] = [
    SCRIPT_PATH,
    opts.filePath,
    "--model", MODEL_NAME,
  ];

  if (DEVICE !== "auto") {
    args.push("--device", DEVICE);
  }

  if (INITIAL_PROMPT) {
    args.push("--initial-prompt", INITIAL_PROMPT);
  }

  const t0 = Date.now();
  console.log(
    `[shunya-hinglish] spawn ${PYTHON_CMD} ${SCRIPT_PATH} model=${MODEL_NAME} device=${DEVICE}`
  );

  return new Promise<WhisperResult>((resolve, reject) => {
    const proc = spawn(PYTHON_CMD, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      // Surface progress lines live in the dev server log
      process.stderr.write(`[shunya-hinglish] ${chunk}`);
    });

    proc.on("error", (err) => {
      reject(
        new Error(
          `shunya-hinglish spawn failed: ${err.message}. ` +
          `Verify Python is on PATH or set SHUNYA_HINGLISH_PYTHON.`
        )
      );
    });

    proc.on("close", (code) => {
      if (code === 2) {
        reject(
          new Error(
            "shunya-hinglish: Python dependencies missing. " +
            "Run: pip install torch transformers librosa soundfile"
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `shunya-hinglish exit ${code}: ${stderr.slice(-400) || "(no stderr)"}`
          )
        );
        return;
      }

      let data: RawOutput;
      try {
        data = JSON.parse(stdout) as RawOutput;
      } catch {
        reject(
          new Error(
            `shunya-hinglish produced non-JSON output: ${stdout.slice(0, 200)}`
          )
        );
        return;
      }

      const words: WhisperWord[] = (data.words ?? []).map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
      }));

      console.log(
        `[shunya-hinglish] ok in ${Date.now() - t0}ms — ` +
        `words=${words.length} duration=${data.duration}s`
      );

      resolve({
        task: "transcribe",
        language: "hi-roman",
        duration: data.duration ?? 0,
        text: data.text ?? "",
        words,
      });
    });
  });
}
