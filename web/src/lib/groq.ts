/**
 * Groq Whisper — cloud Whisper-large-v3-turbo with OpenAI-compatible API.
 *
 * Used for non-Indic languages (English at any accent, Spanish, French,
 * German, etc.) where Sarvam isn't a fit. Groq runs the latest Whisper
 * weights on GPUs at very high throughput; their free tier is 14,400
 * audio-seconds/day for `whisper-large-v3-turbo` — plenty for dev usage.
 *
 * Docs: https://console.groq.com/docs/speech-to-text
 *
 * The wire format is identical to OpenAI's Whisper API, so the response
 * mapping is straightforward.
 */

import { readFile } from "fs/promises";
import { basename } from "path";
import type { WhisperResult, WhisperWord } from "./whisper";

const GROQ_BASE = "https://api.groq.com/openai/v1";

/**
 * Map our spokenLanguage to Whisper's ISO 639-1 code. Groq accepts both
 * the full name ("english") and the code; codes are slightly more reliable
 * across providers, so we use them.
 */
const ISO_CODE: Record<string, string> = {
  english: "en",       spanish: "es",     french: "fr",      german: "de",
  italian: "it",       portuguese: "pt",  dutch: "nl",       russian: "ru",
  ukrainian: "uk",     polish: "pl",      czech: "cs",       slovak: "sk",
  hungarian: "hu",     romanian: "ro",    greek: "el",       turkish: "tr",
  arabic: "ar",        hebrew: "he",      persian: "fa",     japanese: "ja",
  korean: "ko",        chinese: "zh",     cantonese: "yue",  vietnamese: "vi",
  thai: "th",          indonesian: "id",  malay: "ms",       tagalog: "tl",
  swedish: "sv",       danish: "da",      norwegian: "no",   finnish: "fi",
  hindi: "hi",         "hi-roman": "hi",  marathi: "mr",     bengali: "bn",
  tamil: "ta",         telugu: "te",      kannada: "kn",     malayalam: "ml",
  gujarati: "gu",      punjabi: "pa",     urdu: "ur",        nepali: "ne",
};

interface GroqOptions {
  filePath: string;
  spokenLanguage: string;
  translateToEnglish: boolean;
}

// OpenAI verbose_json shape — words[] arrives when timestamp_granularities
// includes "word".
interface GroqResponse {
  text?: string;
  language?: string;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number }>;
  segments?: Array<{ text: string; start: number; end: number }>;
}

export async function transcribeWithGroq(opts: GroqOptions): Promise<WhisperResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const audioBuf = await readFile(opts.filePath);
  const blob = new Blob([new Uint8Array(audioBuf)]);
  const filename = basename(opts.filePath) || "audio.mp3";

  const form = new FormData();
  form.append("file", blob, filename);
  // Turbo is the best speed/quality trade for our use; large-v3 is also
  // available if hallucinations show up on tricky audio.
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("temperature", "0");

  // Translation endpoint always outputs English; for it we don't pass a
  // source language hint (Whisper auto-detects).
  if (!opts.translateToEnglish) {
    const iso = ISO_CODE[opts.spokenLanguage];
    if (iso) form.append("language", iso);
  }

  const endpoint = opts.translateToEnglish
    ? `${GROQ_BASE}/audio/translations`
    : `${GROQ_BASE}/audio/transcriptions`;

  const t0 = Date.now();
  console.log(`[groq] POST ${endpoint} lang=${opts.spokenLanguage} translate=${opts.translateToEnglish}`);

  // 60s timeout so a firewall-blocked multipart upload fails fast and the
  // router can fall back instead of hanging the whole API request.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Groq request timed out after 60s (firewall / network)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Groq ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const data = (await resp.json()) as GroqResponse;
  console.log(`[groq] ok in ${Date.now() - t0}ms — words=${data.words?.length ?? 0} duration=${data.duration}s`);

  // Word-level timestamps preferred; fall back to segments if the model
  // didn't return them (rare for the verbose_json + word granularity
  // combo, but possible).
  const words: WhisperWord[] = [];
  if (data.words?.length) {
    for (const w of data.words) {
      const text = (w.word ?? "").trim();
      if (!text) continue;
      words.push({ word: text, start: w.start, end: w.end });
    }
  } else if (data.segments?.length) {
    // Synthesise approximate word timings by spreading words evenly across
    // each segment's duration. Better than nothing for the captions to
    // line up roughly.
    for (const seg of data.segments) {
      const tokens = (seg.text ?? "").trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const span = (seg.end - seg.start) / tokens.length;
      tokens.forEach((tok, i) => {
        words.push({
          word: tok,
          start: seg.start + i * span,
          end: seg.start + (i + 1) * span,
        });
      });
    }
  }

  return {
    task: opts.translateToEnglish ? "translate" : "transcribe",
    language: data.language ?? opts.spokenLanguage,
    duration: data.duration ?? (words.length ? words[words.length - 1].end : 0),
    text: (data.text ?? words.map((w) => w.word).join(" ")).trim(),
    words,
  };
}
