/**
 * Local Whisper transcription via `@huggingface/transformers` (transformers.js).
 *
 * Why transformers.js (vs nodejs-whisper):
 *  - Pure JS + ONNX runtime. No CMake / VS Build Tools needed on Windows.
 *  - Models download once from HuggingFace (~100 MB for `base`) and cache locally.
 *  - Slightly slower than whisper.cpp but zero native compile.
 *
 * Audio decoding: we shell out to a bundled static `ffmpeg` binary
 * (via `ffmpeg-static`) to convert any input format → 16 kHz mono float32 PCM,
 * which is exactly what the Whisper model expects. No system ffmpeg required.
 */
import { pipeline } from "@huggingface/transformers";
import ffmpegPath from "ffmpeg-static";
import Sanscript from "@indic-transliteration/sanscript";
import { spawn } from "child_process";
import { getSanscriptScheme, type WritingScript } from "./languages";

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface WhisperResult {
  task: string;
  language: string;
  duration: number;
  text: string;
  words: WhisperWord[];
}

/**
 * Speed-vs-accuracy tier picked by the user in the Prepare Media modal.
 * The actual ONNX model is resolved via `MODEL_BY_TIER` so we can swap
 * specific HuggingFace IDs without changing the API surface.
 */
export type AccuracyTier = "fast" | "balanced" | "best";

export interface TranscribeOptions {
  /** Explicit ONNX model name — overrides `accuracy`. */
  model?: string;
  /** Pre-canned tier from the modal. Defaults to "balanced" (whisper-medium). */
  accuracy?: AccuracyTier;
  /**
   * What language is spoken in the audio. Use codes from `lib/languages.ts`.
   * The synthetic code `"hi-roman"` (Hinglish) is treated as Hindi spoken
   * with `writingScript` forced to `"roman"`.
   */
  spokenLanguage?: string;
  /**
   * "native" → keep Whisper's source-language script.
   * "roman" → transliterate non-Latin scripts to Roman after transcription.
   */
  writingScript?: WritingScript;
  /** If true, output is forced English (Whisper translate mode). */
  translateToEnglish?: boolean;
}

/**
 * Tier → model. Sized for typical accuracy needs:
 *   - fast: small (~240MB, weak on Hinglish but quick on CPU)
 *   - balanced: medium (~770MB, good Hindi accuracy, slower CPU inference)
 *   - best: large-v3 (~1.5GB, highest quality, supports word timestamps)
 *
 * IMPORTANT: `large-v3-turbo` was tempting (smaller + faster than full
 * large) but its ONNX export lacks cross-attention outputs, so
 * `return_timestamps: "word"` throws "Model outputs must contain cross
 * attentions". Full `whisper-large-v3` is the safe choice when word-level
 * timestamps are required — which is always, for Captora's per-word caption
 * highlighting.
 */
const MODEL_BY_TIER: Record<AccuracyTier, string> = {
  fast:     "Xenova/whisper-small",
  balanced: "Xenova/whisper-medium",
  best:     "Xenova/whisper-large-v3",
};

const DEFAULT_TIER: AccuracyTier = "balanced";

function resolveModel(opts: TranscribeOptions): string {
  if (opts.model) return opts.model;
  return MODEL_BY_TIER[opts.accuracy ?? DEFAULT_TIER];
}

/**
 * Indic-script → casual Hinglish via Sanscript + targeted post-processing.
 *
 * Sanscript's `optitrans` scheme is the closest readable Roman, but it still
 * uses ITRANS-style markers that look academic in social-media captions:
 *   - Capital letters for long vowels (A I U) and retroflex consonants (T D N S)
 *   - `M` / `.n` / `.m` / `~` for anusvar / nasalisation
 *   - Trailing `a` for the inherent Sanskrit schwa that Hindi mostly drops
 *
 * We post-process to plain readable Hinglish:
 *   - Replace nasal markers with `n`
 *   - Drop word-final schwa (lowercase `a` after a consonant) — done before
 *     lowercasing so a real long vowel `A` (kept) stays distinguishable
 *   - Lowercase everything (loses retroflex/dental distinction; Hinglish
 *     readers don't carry that markup anyway)
 */
function makeRomaniser(sourceScript: string): (text: string) => string {
  return (text: string) => devanagariStyleToHinglish(text, sourceScript);
}

function devanagariStyleToHinglish(text: string, sourceScript: string): string {
  let s = Sanscript.t(text, sourceScript, "optitrans");

  // Nasal markers → 'n'.  ".n", ".m", "M", "~" all collapse to the same sound
  // in casual reading.
  s = s.replace(/\.[nm]/gi, "n");
  s = s.replace(/M/g, "n");
  s = s.replace(/~/g, "n");
  // Strip any remaining structural dots (halant/visarga artefacts).
  s = s.replace(/\./g, "");

  // Word-final schwa deletion. Pattern: 2+ non-whitespace chars ending in a
  // consonant, immediately followed by lowercase `a` at a word boundary.
  // Lowercase `a` = inherent schwa; uppercase `A` = real long ā (kept).
  //   "tarUNa" → "tarUN"   (correct: तरुण = "tarun")
  //   "merA"   → "merA"    (kept: मेरा = "mera", final A is the long vowel)
  //   "AdhAra" → "AdhAr"   (correct: आधार = "adhar")
  s = s.replace(/(\S{2,}?[^aeiouAEIOU\s])a(?=\s|$|[.,;:!?])/g, "$1");

  return s.toLowerCase();
}

/**
 * Map our user-facing `spokenLanguage` value (which includes the synthetic
 * `"hi-roman"` Hinglish code) to:
 *   - what we tell Whisper as `language`
 *   - which post-processing transliteration to apply
 */
function planTranscription(opts: TranscribeOptions): {
  whisperLanguage: string;
  task: "transcribe" | "translate";
  postProcess: (s: string) => string;
} {
  if (opts.translateToEnglish) {
    return { whisperLanguage: "english", task: "translate", postProcess: (s) => s };
  }

  const spoken = opts.spokenLanguage ?? "english";

  // Hinglish: synthetic "hi-roman" code → Hindi audio → Devanagari → Roman.
  if (spoken === "hi-roman") {
    return {
      whisperLanguage: "hindi",
      task: "transcribe",
      postProcess: makeRomaniser("devanagari"),
    };
  }

  // For real language codes, decide post-processing from the language's
  // Sanscript scheme (set in `lib/languages.ts`) and the user's writing-script
  // toggle. If `writingScript=roman` and the language has a scheme, romanise.
  const scheme = getSanscriptScheme(spoken);
  if (opts.writingScript === "roman" && scheme) {
    return {
      whisperLanguage: spoken,
      task: "transcribe",
      postProcess: makeRomaniser(scheme),
    };
  }

  // Otherwise: transcribe in source language, leave script as-is.
  return { whisperLanguage: spoken, task: "transcribe", postProcess: (s) => s };
}

// Per-model pipeline cache. Each model loads + warms up on first use; we
// keep them keyed so switching tiers in the modal doesn't re-download.
// Memory cost: each loaded model holds onto its weights, so a long-running
// dev server that's tried all tiers will sit on ~1.7 GB of RAM.
const pipelineCache = new Map<string, Promise<unknown>>();
function getTranscriber(model: string) {
  const cached = pipelineCache.get(model);
  if (cached) return cached;
  console.log(`[whisper] loading model ${model} (first call downloads from HuggingFace)...`);
  const p = pipeline("automatic-speech-recognition", model);
  pipelineCache.set(model, p);
  return p;
}

/**
 * Decode any audio file → Float32Array of 16 kHz mono samples by piping
 * through the bundled static ffmpeg. Output is raw f32le on stdout.
 */
async function decodeAudio(inputPath: string): Promise<Float32Array> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide a binary path for this platform");
  }

  return new Promise<Float32Array>((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, [
      "-y",
      "-i", inputPath,
      "-f", "f32le",
      "-acodec", "pcm_f32le",
      "-ac", "1",
      "-ar", "16000",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        return;
      }
      const raw = Buffer.concat(chunks);
      const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      resolve(new Float32Array(audio));
    });
  });
}

/**
 * Transcribe an audio/video file already saved to disk. The caller is
 * responsible for the file lifecycle (saving, eventual cleanup) — this
 * function only reads it. Caller-managed lifecycle lets /api/transcribe
 * keep the file around for /api/render to reuse.
 */
export async function transcribeWithWhisper(
  filePath: string,
  opts: TranscribeOptions = {}
): Promise<WhisperResult> {
  const t0 = Date.now();
  const audio = await decodeAudio(filePath);
  console.log(`[whisper] decoded ${(audio.length / 16000).toFixed(2)}s of audio in ${Date.now() - t0}ms`);

  const modelName = resolveModel(opts);
  const transcriber = (await getTranscriber(modelName)) as (
    input: Float32Array,
    options: Record<string, unknown>
  ) => Promise<{
    text: string;
    chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] }>;
  }>;

  const { whisperLanguage, task, postProcess } = planTranscription(opts);

  const t1 = Date.now();
  // Phrase-level timestamps are far more reliable than word-level on
  // transformers.js / Xenova ONNX exports. Word-level (`"word"`) often
  // produces clustered or hallucinated timestamps on short audio because
  // the 30-sec chunk window pads with silence. Phrase-level chunks line
  // up with actual speech; we then split each phrase into words ourselves
  // and distribute them within the phrase's time window.
  const audioActualDurationSec = audio.length / 16000;
  const output = await transcriber(audio, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    language: whisperLanguage,
    task,
  });

  const rawText = (output.text ?? "").trim();
  console.log(
    `[whisper] transcribed in ${Date.now() - t1}ms (model=${modelName} whisperLang=${whisperLanguage} task=${task} script=${opts.writingScript ?? "native"})`
  );
  console.log(`[whisper] raw output sample: ${JSON.stringify(rawText.slice(0, 200))}`);

  // Sanity check: if we asked for an Indic language and got back zero
  // non-Latin glyphs, the model probably ignored the language hint and
  // produced English instead — warn loudly so the user knows the captions
  // they see are NOT what the picker promised.
  if (
    task === "transcribe" &&
    /^(hindi|marathi|nepali|sanskrit|bengali|assamese|punjabi|gujarati|tamil|telugu|kannada|malayalam)$/.test(whisperLanguage) &&
    !/[^\x00-\x7F]/.test(rawText)
  ) {
    console.warn(
      `[whisper] WARNING: language=${whisperLanguage} but raw output has no non-Latin characters. The model likely transcribed as English. Try a larger model (Xenova/whisper-medium) or verify the audio language.`
    );
  }

  // Phrase-level chunks → split each phrase into words and distribute
  // timestamps inside the phrase's [start, end] window. Phrase boundaries
  // from Whisper are accurate; the per-word distribution inside is
  // approximate.
  //
  // We weight each word's slice by its character count rather than splitting
  // the phrase evenly, because real speech is NOT uniform: short common words
  // like "the" / "है" / "का" are spoken in ~60-100ms while long content
  // words like "understanding" / "मुख्यमंत्री" take 400-600ms. Even
  // distribution made the caption highlight drift visibly out of sync
  // within longer phrases — character-weighted distribution lines up much
  // closer to the actual spoken rhythm. Each character gets ~equal time;
  // a 10-letter word gets ~10× the slice of a 1-letter word.
  const words: WhisperWord[] = [];
  for (const chunk of output.chunks ?? []) {
    const phraseText = (chunk.text ?? "").trim();
    if (!phraseText) continue;
    const [pStartRaw, pEndRaw] = chunk.timestamp ?? [null, null];
    const pStart = Math.min(
      Math.max(pStartRaw ?? 0, 0),
      audioActualDurationSec
    );
    const pEnd = Math.min(
      Math.max(pEndRaw ?? pStart, pStart),
      audioActualDurationSec
    );

    const tokens = phraseText.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    const phraseDur = Math.max(0.05, pEnd - pStart);

    // Floor each character count at 1 so a single-letter word ("I", "a",
    // "ह") still gets a real slice — and add a small "+1" to every count
    // so the weighting isn't *too* extreme (otherwise a 1-letter word
    // next to a 12-letter word gets 1/13 of the phrase, which is too
    // tight; +1 makes it 2/14, closer to natural pacing).
    const charWeights = tokens.map((t) => Math.max(1, t.length) + 1);
    const totalWeight = charWeights.reduce((a, b) => a + b, 0);

    let cursor = pStart;
    tokens.forEach((token, i) => {
      const wDur = (charWeights[i] / totalWeight) * phraseDur;
      const start = cursor;
      // Last word: snap to phrase end so accumulated rounding can't leave
      // a gap between the final word and the next phrase's entrance.
      const end = i === tokens.length - 1 ? pEnd : start + wDur;
      cursor = end;
      words.push({
        word: postProcess(token),
        start,
        end,
      });
    });
  }

  // Use the actual decoded audio length, not the last word's end —
  // protects downstream consumers (preview Player, MP4 renderer) from
  // any leftover hallucinated end timestamps.
  const duration = audioActualDurationSec;
  const fullText = postProcess(rawText);

  return {
    task,
    language: opts.spokenLanguage ?? whisperLanguage,
    duration,
    text: fullText,
    words,
  };
}
