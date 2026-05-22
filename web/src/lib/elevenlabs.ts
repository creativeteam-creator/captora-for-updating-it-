/**
 * ElevenLabs Scribe — speech-to-text via the `scribe_v1` model.
 *
 * Used as the primary provider when `ELEVENLABS_API_KEY` is set. Falls
 * through to faster-whisper / Groq / local on quota errors (402),
 * rate limits (429), invalid key (401), or any other failure — the
 * router catches the throw and tries the next provider in line.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text
 *
 * Returns Devanagari for Hindi (and other native scripts) — the same
 * Hinglish-LLM polish step that follows Whisper providers also
 * applies here.
 */
import { readFile, stat, unlink } from "fs/promises";
import { basename } from "path";
import type { WhisperResult, WhisperWord } from "./whisper";
import { extractAudioToMp3 } from "./audio-extract";

/**
 * Files above ~40 MB get the audio-only treatment: we pre-extract a
 * 128 kbps mono 16 kHz MP3 and upload that instead of the original
 * video container. Two wins:
 *   - Avoids minutes of HTTP upload latency that hit the 5-min ABORT
 *     ceiling on bigger video files (the 955 MB upload on Mac mini that
 *     timed out before the request even finished streaming).
 *   - Keeps us comfortably below ElevenLabs's documented upload caps.
 *
 * 40 MB chosen as the cutoff because a 10-min 1080p clip is roughly
 * that size — short content uploads fast enough to skip the extract
 * round-trip, longer content always extracts first.
 */
const EXTRACT_AUDIO_THRESHOLD_BYTES = 40_000_000;

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

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

interface Options {
  filePath: string;
  spokenLanguage: string;
  translateToEnglish: boolean;
}

interface ElevenLabsWord {
  text: string;
  // ElevenLabs marks individual entries as "word" / "spacing" / sometimes
  // "audio_event". We only keep "word" entries for caption rendering.
  type: string;
  start: number;
  end: number;
}

interface ElevenLabsResponse {
  language_code?: string;
  language_probability?: number;
  text: string;
  words?: ElevenLabsWord[];
}

export function isElevenLabsEnabled(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

export async function transcribeWithElevenLabs(opts: Options): Promise<WhisperResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  // Scribe only does source-language transcription, not translate-to-EN.
  // Throwing here makes the router fall through to a provider that does
  // (Whisper translate task on Groq / faster-whisper).
  if (opts.translateToEnglish) {
    throw new Error("elevenlabs: translate-to-english not supported, falling through");
  }

  // Decide whether to upload the original file or an extracted audio
  // track. Big videos (multi-GB) blow up Node's readFile and exceed the
  // provider's request-size cap, so for those we transcode to a small
  // MP3 first and clean it up after.
  const fileSize = (await stat(opts.filePath)).size;
  let uploadPath = opts.filePath;
  let extractedTempPath: string | null = null;
  if (fileSize > EXTRACT_AUDIO_THRESHOLD_BYTES) {
    console.log(
      `[elevenlabs] file size ${(fileSize / 1e9).toFixed(2)}GB exceeds ` +
      `${(EXTRACT_AUDIO_THRESHOLD_BYTES / 1e9).toFixed(1)}GB threshold — extracting audio first`
    );
    extractedTempPath = await extractAudioToMp3(opts.filePath);
    uploadPath = extractedTempPath;
    const newSize = (await stat(uploadPath)).size;
    console.log(`[elevenlabs] extracted audio: ${(newSize / 1e6).toFixed(1)} MB`);
  }

  try {
    const audioBuf = await readFile(uploadPath);
    const blob = new Blob([new Uint8Array(audioBuf)]);
    const filename = basename(uploadPath) || "audio.mp3";

    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model_id", "scribe_v1");
    // No audio-event tags ([music], [laughter] etc.) — cleaner captions.
    form.append("tag_audio_events", "false");
    // Word-level timestamps line up with the per-word caption highlight.
    form.append("timestamp_granularity", "word");

    const iso = ISO_CODE[opts.spokenLanguage];
    if (iso) form.append("language_code", iso);

    const t0 = Date.now();
    console.log(`[elevenlabs] POST /speech-to-text lang=${opts.spokenLanguage} iso=${iso ?? "auto"}`);

    // Long timeout — 30-min videos can take a couple of minutes server-side.
    // Router catches the AbortError and falls back to the next provider.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300_000);

    let resp: Response;
    try {
      resp = await fetch(`${ELEVENLABS_BASE}/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: ctrl.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error("ElevenLabs request timed out after 5min");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const body = await resp.text();
      // 401 invalid key, 402 quota exhausted, 429 rate limit, 5xx server —
      // all surface as throws so the router moves to the next provider.
      throw new Error(`ElevenLabs ${resp.status}: ${body.slice(0, 300)}`);
    }

    return await parseAndReturn(resp, opts, t0);
  } finally {
    if (extractedTempPath) {
      try { await unlink(extractedTempPath); } catch { /* best-effort cleanup */ }
    }
  }
}

async function parseAndReturn(
  resp: Response,
  opts: Options,
  t0: number
): Promise<WhisperResult> {
  const data = (await resp.json()) as ElevenLabsResponse;
  const wordEntries = (data.words ?? []).filter((w) => w.type === "word");
  console.log(
    `[elevenlabs] ok in ${Date.now() - t0}ms — words=${wordEntries.length} ` +
    `lang=${data.language_code ?? "?"} prob=${data.language_probability?.toFixed(2) ?? "?"}`
  );

  const words: WhisperWord[] = [];
  let dropped = 0;
  for (const w of wordEntries) {
    const text = (w.text ?? "").trim();
    if (!text) continue;
    const start = typeof w.start === "number" ? w.start : 0;
    const end = typeof w.end === "number" ? w.end : 0;
    // Drop hallucinated / junk entries that ElevenLabs returns during
    // music or silence sections. Symptoms in the wild:
    //   - end <= start  (impossible duration)
    //   - end - start < 30ms (no real spoken word is this short; these
    //     are usually marker tokens emitted during background music or
    //     coughs; they cluster at one timestamp and form a 70-word
    //     "phrase" that fills the entire preview frame as a text wall)
    if (end <= start) { dropped++; continue; }
    if (end - start < 0.03) { dropped++; continue; }
    words.push({ word: text, start, end });
  }
  if (dropped > 0) {
    console.log(`[elevenlabs] dropped ${dropped} hallucinated/zero-duration word(s)`);
  }

  const duration = words.length ? words[words.length - 1].end : 0;

  return {
    task: "transcribe",
    language: data.language_code ?? opts.spokenLanguage,
    duration,
    text: (data.text ?? "").trim(),
    words,
  };
}
