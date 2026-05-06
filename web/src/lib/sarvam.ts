/**
 * Sarvam AI Saaras — Indic-specialised speech-to-text.
 *
 * Sarvam is an India-based ASR with native Hindi / Hinglish / regional
 * Indian language support. Their `saarika` model handles transcription
 * in source language, `saaras` handles speech-to-English-translation.
 *
 * Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text
 *
 * Word-level timestamps are returned via `with_timestamps=true`. We always
 * return Devanagari / native script — the router transliterates if the
 * user picked Roman script.
 *
 * On any failure (auth, quota, network) this throws — the router falls
 * back to local Whisper so the user still gets captions.
 */

import { readFile } from "fs/promises";
import { basename } from "path";
import type { WhisperResult, WhisperWord } from "./whisper";

const SARVAM_BASE = "https://api.sarvam.ai";

/**
 * Map our spokenLanguage codes to Sarvam's BCP-47 `language_code` values.
 * Sarvam supports all major Indian languages — anything not listed here
 * triggers a router-level fallback to a different provider.
 */
const SARVAM_LANGUAGE_CODE: Record<string, string> = {
  "hindi":     "hi-IN",
  "hi-roman":  "hi-IN",   // Hinglish → ask for Hindi, romanise post-call
  "marathi":   "mr-IN",
  "bengali":   "bn-IN",
  "punjabi":   "pa-IN",
  "gujarati":  "gu-IN",
  "tamil":     "ta-IN",
  "telugu":    "te-IN",
  "kannada":   "kn-IN",
  "malayalam": "ml-IN",
  "english":   "en-IN",
};

export function isSarvamLanguage(code: string): boolean {
  return code in SARVAM_LANGUAGE_CODE;
}

interface SarvamOptions {
  filePath: string;
  spokenLanguage: string;
  translateToEnglish: boolean;
}

interface SarvamResponse {
  transcript?: string;
  language_code?: string;
  // Sarvam's word-timestamp shape:
  timestamps?: {
    words?: string[];
    start_time_seconds?: number[];
    end_time_seconds?: number[];
  };
  // Some endpoints return a flat words array — handle both for safety.
  words?: Array<{ word?: string; start?: number; end?: number; start_time?: number; end_time?: number }>;
  error?: { message?: string };
}

export async function transcribeWithSarvam(opts: SarvamOptions): Promise<WhisperResult> {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY not set");

  const langCode = SARVAM_LANGUAGE_CODE[opts.spokenLanguage];
  if (!langCode) throw new Error(`Sarvam: unsupported language ${opts.spokenLanguage}`);

  const audioBuf = await readFile(opts.filePath);
  // Use Blob (Web API) so fetch/FormData multipart serialises correctly.
  const blob = new Blob([new Uint8Array(audioBuf)]);
  const filename = basename(opts.filePath) || "audio.mp3";

  const form = new FormData();
  form.append("file", blob, filename);
  form.append(
    "model",
    opts.translateToEnglish ? "saaras:v2.5" : "saarika:v2.5"
  );
  form.append("language_code", langCode);
  form.append("with_timestamps", "true");

  const endpoint = opts.translateToEnglish
    ? `${SARVAM_BASE}/speech-to-text-translate`
    : `${SARVAM_BASE}/speech-to-text`;

  const t0 = Date.now();
  console.log(`[sarvam] POST ${endpoint} lang=${langCode} translate=${opts.translateToEnglish}`);

  // 60s timeout so a firewall-blocked multipart upload fails fast and we
  // can fall back to the next provider, instead of hanging the whole API.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { "api-subscription-key": apiKey },
      body: form,
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Sarvam request timed out after 60s (firewall / network)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Sarvam ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const data = (await resp.json()) as SarvamResponse;
  console.log(`[sarvam] ok in ${Date.now() - t0}ms — transcript chars=${(data.transcript ?? "").length}`);

  // Two timestamp shapes — normalise to our WhisperWord[].
  const words: WhisperWord[] = [];
  if (data.timestamps?.words?.length) {
    const ts = data.timestamps;
    const starts = ts.start_time_seconds ?? [];
    const ends = ts.end_time_seconds ?? [];
    ts.words!.forEach((w, i) => {
      const text = (w ?? "").trim();
      if (!text) return;
      words.push({
        word: text,
        start: starts[i] ?? 0,
        end: ends[i] ?? starts[i] ?? 0,
      });
    });
  } else if (Array.isArray(data.words)) {
    for (const w of data.words) {
      const text = (w.word ?? "").trim();
      if (!text) continue;
      words.push({
        word: text,
        start: w.start ?? w.start_time ?? 0,
        end: w.end ?? w.end_time ?? 0,
      });
    }
  }

  const fullText = (data.transcript ?? words.map((w) => w.word).join(" ")).trim();
  const duration = words.length ? words[words.length - 1].end : 0;

  return {
    task: opts.translateToEnglish ? "translate" : "transcribe",
    language: data.language_code ?? langCode,
    duration,
    text: fullText,
    words,
  };
}
