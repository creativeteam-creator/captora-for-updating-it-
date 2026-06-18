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

    // Long timeout — 40-min consultation videos can take 3-8 minutes
    // server-side at peak ElevenLabs load. The old 5-min ceiling clipped
    // anything past ~25 min audio, so the router silently dropped the
    // user onto CPU Whisper (low quality). 15 min covers the upper end
    // of clinic content without making genuine outages drag on too long.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 900_000);

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
        throw new Error("ElevenLabs request timed out after 15min");
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
  let clamped = 0;
  // Real spoken words rarely exceed this duration. ElevenLabs sometimes
  // emits a single "word" whose end timestamp extends across an entire
  // music / silence segment — a 22-min consultation video came back with
  // a "treatment" token spanning 8 seconds, which then displayed as the
  // only caption on screen for that whole window (because the
  // PhraseCaption duration follows the word's own start–end span).
  // Clamp anything past 4 seconds back to start + 4s so the rest of the
  // timeline gets a chance to render normally.
  const MAX_WORD_DURATION_SEC = 4.0;
  for (const w of wordEntries) {
    const text = (w.text ?? "").trim();
    if (!text) continue;
    const start = typeof w.start === "number" ? w.start : 0;
    let end = typeof w.end === "number" ? w.end : 0;
    // Drop hallucinated / junk entries:
    //   - end <= start (impossible duration)
    //   - end - start < 10ms (these are marker tokens emitted during
    //     background music / coughs; they cluster at one timestamp and
    //     form a 70-word "phrase" that fills the preview frame as a
    //     text wall). Previously this threshold was 30ms, which also
    //     killed legitimate fast-spoken Hindi/Hinglish connectors
    //     ("k", "h", "m", "to") in rapid speech — a chunk of the
    //     "words skip ho rahe hain" reports on long-form videos.
    //     10ms is well below any real spoken duration but still nukes
    //     the music-burst markers.
    if (end <= start) { dropped++; continue; }
    if (end - start < 0.01) { dropped++; continue; }
    // Clamp pathologically long-duration "words". This is the fix for
    // the "ek single word for multiple lines worth of audio" bug —
    // without this a hallucinated 30-second word would occupy 30s of
    // screen time as the only visible caption.
    if (end - start > MAX_WORD_DURATION_SEC) {
      end = start + MAX_WORD_DURATION_SEC;
      clamped++;
    }
    words.push({ word: text, start, end });
  }
  if (dropped > 0) {
    console.log(`[elevenlabs] dropped ${dropped} hallucinated/zero-duration word(s)`);
  }
  if (clamped > 0) {
    console.log(
      `[elevenlabs] clamped ${clamped} word(s) with duration > ${MAX_WORD_DURATION_SEC}s back to ${MAX_WORD_DURATION_SEC}s ` +
      `(hallucinated long-duration tokens — usually appear during music / silence sections)`
    );
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
