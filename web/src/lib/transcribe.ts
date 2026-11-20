/**
 * Transcription router. Picks the best provider for the user's language,
 * applies shared post-processing (Roman script transliteration), and
 * falls back to local Whisper on any cloud failure.
 *
 * Routing rules:
 *   - Indic language + SARVAM_API_KEY set       → Sarvam Saaras (India-tuned)
 *   - Any other language + GROQ_API_KEY set     → Groq Whisper-large-v3-turbo
 *   - English with foreign accents              → Groq (Whisper handles all
 *                                                  accents well at large-v3)
 *   - Both keys missing OR API call fails       → local Whisper (this is
 *                                                  always available)
 *
 * Each provider returns raw native-script words. The router then romanises
 * if the user picked Roman script (or selected the synthetic "Hinglish"
 * language). This keeps transliteration logic in one place.
 */

import {
  transcribeWithWhisper as transcribeWithLocalWhisper,
  type AccuracyTier,
  type WhisperResult,
} from "./whisper";
import { transcribeWithSarvam, isSarvamLanguage } from "./sarvam";
import { transcribeWithGroq } from "./groq";
import {
  transcribeWithFasterWhisper,
  isFasterWhisperEnabled,
} from "./faster-whisper";
import {
  transcribeWithShunyaHinglish,
  isShunyaHinglishEnabled,
} from "./shunya-hinglish";
import {
  transcribeWithElevenLabs,
  isElevenLabsEnabled,
} from "./elevenlabs";
import { decideRomanization, romaniseText, romaniseWords } from "./script";
import {
  transliterateWordsToHinglish,
  transliterateTextToHinglish,
  isDevanagari,
  isHinglishLLMEnabled,
  applyPhoneticEnglishSafetyNet,
} from "./hinglish-llm";
import type { WritingScript } from "./languages";

export type TranscribeProvider =
  | "elevenlabs"           // primary cloud provider (paid quota); falls back on quota/rate-limit
  | "shunya-hinglish"      // native Hinglish model — best for hi-roman
  | "faster-whisper-gpu"
  | "sarvam"
  | "groq"
  | "local-whisper";

export interface TranscribeRequest {
  filePath: string;
  spokenLanguage: string;
  writingScript: WritingScript;
  translateToEnglish: boolean;
  /** Only used when we fall through to the local provider. */
  accuracy?: AccuracyTier;
}

export interface TranscribeResult extends WhisperResult {
  provider: TranscribeProvider;
}

const INDIC_LANGUAGES = new Set([
  "hindi", "hi-roman", "marathi", "nepali", "sanskrit",
  "bengali", "assamese", "punjabi", "gujarati",
  "tamil", "telugu", "kannada", "malayalam",
]);

function isIndic(code: string): boolean {
  return INDIC_LANGUAGES.has(code);
}

export async function transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
  // Decide provider order — primary first, then fallback options.
  const order = pickProviderOrder(req);

  let lastError: unknown = null;
  for (const provider of order) {
    try {
      console.log(`[transcribe] trying provider=${provider}`);
      const raw = await callProvider(provider, req);
      const repaired = repairTimestamps(raw, provider);
      const finalised = await applyRomanizationIfNeeded(repaired, req, provider);
      // Final safety pass — runs whether the LLM polish step inside
      // applyRomanizationIfNeeded succeeded, fell back to optitrans,
      // or all LLM providers hit daily quota. Previously the safety
      // net only ran inside the LLM polish function, so a day where
      // both Gemini and Groq tripped their 429s left rough Roman
      // ("laiph", "koanphidentali", "heyar") in the captions.
      const safe = applyPhoneticEnglishSafetyNet(finalised.words, finalised.text);
      return { ...finalised, words: safe.words, text: safe.text, provider };
    } catch (err) {
      lastError = err;
      console.warn(`[transcribe] provider=${provider} failed:`, err instanceof Error ? err.message : err);
      // Continue to next provider.
    }
  }

  // All providers exhausted.
  throw lastError instanceof Error
    ? lastError
    : new Error("All transcription providers failed");
}

function pickProviderOrder(req: TranscribeRequest): TranscribeProvider[] {
  const order: TranscribeProvider[] = [];
  const hasElevenLabs = isElevenLabsEnabled();
  const hasFasterWhisper = isFasterWhisperEnabled();
  const hasShunyaHinglish = isShunyaHinglishEnabled();
  const hasSarvam = !!process.env.SARVAM_API_KEY;
  const hasGroq = !!process.env.GROQ_API_KEY;
  const isHinglish = req.spokenLanguage === "hi-roman";

  // ── ElevenLabs primary ───────────────────────────────────────────────────
  // Highest priority when an API key is set: highest accuracy STT we
  // have access to, with proper word timestamps. ElevenLabs only does
  // source-language transcription (no translate-to-EN), so we skip it
  // when translateToEnglish is set. On quota / rate-limit / network
  // failure the router catches the throw and tries the next provider.
  if (hasElevenLabs && !req.translateToEnglish) {
    order.push("elevenlabs");
  }

  // ── Hinglish (hi-roman) fast path ────────────────────────────────────────
  // Shunya model outputs native Roman Hinglish without any transliteration
  // step — much more natural than Whisper→Devanagari→optitrans.
  if (isHinglish && hasShunyaHinglish) {
    order.push("shunya-hinglish");
  }

  // Local GPU Whisper — fastest for all non-Hinglish languages, and also
  // a solid Hinglish fallback when Shunya isn't installed.
  if (hasFasterWhisper) {
    order.push("faster-whisper-gpu");
  }

  if (isIndic(req.spokenLanguage) && hasSarvam && isSarvamLanguage(req.spokenLanguage)) {
    order.push("sarvam");
  }
  if (hasGroq) {
    // Groq for non-Indic primary, OR as fallback after Sarvam for Indic.
    order.push("groq");
  }
  // Local CPU Whisper is always the final fallback — no key needed, slowest path.
  order.push("local-whisper");
  return order;
}

async function callProvider(
  provider: TranscribeProvider,
  req: TranscribeRequest
): Promise<WhisperResult> {
  const providerSpokenLanguage =
    req.spokenLanguage === "hi-roman" ? "hindi" : req.spokenLanguage;
  switch (provider) {
    case "elevenlabs":
      return transcribeWithElevenLabs({
        filePath: req.filePath,
        spokenLanguage: providerSpokenLanguage,
        translateToEnglish: req.translateToEnglish,
      });
    case "shunya-hinglish":
      // Native Hinglish model — outputs Roman Hinglish directly.
      // No transliteration needed; skip applyRomanizationIfNeeded for this provider.
      return transcribeWithShunyaHinglish({ filePath: req.filePath });
    case "faster-whisper-gpu":
      return transcribeWithFasterWhisper({
        filePath: req.filePath,
        spokenLanguage: providerSpokenLanguage,
        translateToEnglish: req.translateToEnglish,
      });
    case "sarvam":
      return transcribeWithSarvam({
        filePath: req.filePath,
        spokenLanguage: providerSpokenLanguage,
        translateToEnglish: req.translateToEnglish,
      });
    case "groq":
      return transcribeWithGroq({
        filePath: req.filePath,
        spokenLanguage: providerSpokenLanguage,
        translateToEnglish: req.translateToEnglish,
      });
    case "local-whisper":
      // Local Whisper does its own transliteration internally for
      // backward-compat with `/api/transcribe` callers that still hit it
      // directly. Since we apply romanization separately in the router,
      // pass writingScript=native here so it leaves the script alone.
      return transcribeWithLocalWhisper(req.filePath, {
        spokenLanguage: providerSpokenLanguage,
        writingScript: "native",
        translateToEnglish: req.translateToEnglish,
        accuracy: req.accuracy,
      });
  }
}

/**
 * Some providers — especially local Xenova/whisper-medium / -large via
 * transformers.js — silently fail to produce word-level timestamps and
 * return all words as `start=0, end=0`. The captions list shows the words
 * but the player can never display them (every word is at frame 0). When
 * we detect this state, spread the words evenly across the audio duration
 * so captions at least *appear* — not perfectly synced, but visible.
 *
 * This is a fallback. Proper timestamps come from faster-whisper-gpu /
 * Sarvam / Groq. The router still tries those first; this just keeps the
 * editor usable when only the local CPU path succeeded.
 */
function repairTimestamps(
  raw: WhisperResult,
  provider: TranscribeProvider
): WhisperResult {
  const total = raw.words.length;
  if (total === 0) return raw;

  const ends = raw.words.map((w) => w.end);
  const starts = raw.words.map((w) => w.start);
  const maxEnd = Math.max(...ends);
  const minStart = Math.min(...starts);
  const span = maxEnd - minStart;

  // Three failure modes we've seen in practice:
  //   1. allZero       — model omitted word timestamps entirely
  //   2. clusteredTiny — words bunched in <10% of audio (transformers.js
  //                       whisper-medium hallucinating timestamps in the
  //                       silence padding of a 30-sec chunk window)
  //   3. outOfRange    — timestamps run past the audio duration
  const allZero = ends.every((e) => e === 0);
  const clusteredTiny = total > 3 && raw.duration > 0 && span < raw.duration * 0.1;
  const outOfRange = raw.duration > 0 && maxEnd > raw.duration * 1.2;

  if (!allZero && !clusteredTiny && !outOfRange) return raw;

  const totalDur = raw.duration > 0 ? raw.duration : total * 0.4;
  const perWord = totalDur / total;
  console.warn(
    `[transcribe] provider=${provider}: timestamps look broken ` +
    `(allZero=${allZero}, clusteredTiny=${clusteredTiny}, outOfRange=${outOfRange}, ` +
    `span=${span.toFixed(2)}s, declaredDuration=${raw.duration.toFixed(2)}s). ` +
    `Spreading ${total} words evenly across ${totalDur.toFixed(1)}s as a fallback.`
  );
  return {
    ...raw,
    duration: totalDur,
    words: raw.words.map((w, i) => ({
      word: w.word,
      start: i * perWord,
      end: (i + 1) * perWord,
    })),
  };
}

async function applyRomanizationIfNeeded(
  raw: WhisperResult,
  req: TranscribeRequest,
  provider: TranscribeProvider
): Promise<WhisperResult> {
  // shunya-hinglish already outputs Roman Hinglish natively — no further work.
  if (provider === "shunya-hinglish") return raw;

  const { romanize, sourceScript } = decideRomanization({
    spokenLanguage: req.spokenLanguage,
    writingScript: req.writingScript,
    translateToEnglish: req.translateToEnglish,
  });
  if (!romanize || !sourceScript) return raw;

  // ── 2-pass LLM Hinglish polish ──────────────────────────────────────────
  // Two cases benefit from running the LLM polish:
  //   1. Provider returned Devanagari (faster-whisper / Sarvam) → transliterate
  //      to natural Roman Hinglish ("apni" not "apani").
  //   2. Provider returned ROUGH Roman Hinglish with phonetic errors —
  //      ElevenLabs Scribe in particular outputs Roman directly for Hindi
  //      audio, with mistakes like "aine" / "doaktar" / "menbar" / "nanbar"
  //      that need fixing. The same LLM, with an updated prompt, handles
  //      both cases.
  //
  // Falls back to optitrans if Groq fails.
  const firstWord = raw.words[0]?.word ?? raw.text.split(" ")[0] ?? "";
  const outputIsDevanagari = isDevanagari(raw.text) || isDevanagari(firstWord);
  const isHinglishTarget = req.spokenLanguage === "hi-roman";
  const shouldPolishLLM = outputIsDevanagari || isHinglishTarget;

  if (shouldPolishLLM && isHinglishLLMEnabled()) {
    try {
      const t0 = Date.now();
      const [llmWords, llmText] = await Promise.all([
        transliterateWordsToHinglish(raw.words),
        transliterateTextToHinglish(raw.text),
      ]);
      console.log(`[transcribe] LLM Hinglish transliteration done in ${Date.now() - t0}ms`);
      return { ...raw, text: llmText, words: llmWords };
    } catch (err) {
      console.warn(
        "[transcribe] LLM transliteration failed, falling back to optitrans:",
        err instanceof Error ? err.message : err
      );
      // Fall through to optitrans below — but only when the input is
      // actually Devanagari. Running optitrans regex on already-Roman
      // text would mangle it.
    }
  }

  // ── Fallback: optitrans (regex-based romanization) ───────────────────────
  // Only valid when the source is a non-Latin script. If the provider
  // already returned Roman (e.g. ElevenLabs Hinglish) and the LLM polish
  // failed, return the raw Roman text as-is rather than corrupt it.
  if (!outputIsDevanagari) {
    return raw;
  }
  return {
    ...raw,
    text: romaniseText(raw.text, sourceScript),
    words: romaniseWords(raw.words, sourceScript),
  };
}
