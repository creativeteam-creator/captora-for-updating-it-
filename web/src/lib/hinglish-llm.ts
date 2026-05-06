/**
 * LLM-powered Hindi → Hinglish transliterator.
 *
 * WHY this is better than optitrans (Sanscript):
 *   - LLM understands context: "जाते" → "jaate" not "jate"
 *   - Correct schwa deletion: "अपनी" → "apni" not "apani"
 *   - Preserves English loanwords: "transplant", "clinic" stay as-is
 *   - Natural spellings: "क्योंकि" → "kyunki", "इन्होंने" → "unhone"
 *   - No regex rules to maintain — the model just knows Hindi phonology
 *
 * Pipeline:
 *   1. Whisper transcribes audio → Devanagari words + timestamps
 *   2. This module batches those words → Groq LLaMA → Hinglish words
 *   3. Timestamps are preserved exactly — only the word text changes
 *
 * Enable:  set GROQ_API_KEY in .env.local (already used for audio transcription)
 * Model:   llama-3.1-8b-instant (fast, free tier, great Hindi→Hinglish)
 *          override with HINGLISH_LLM_MODEL env var
 */

import type { WhisperWord } from "./whisper";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const GROQ_BASE = "https://api.groq.com/openai/v1";

// Smaller model = lower latency. llama-3.1-8b-instant handles Hindi perfectly.
const LLM_MODEL =
  process.env.HINGLISH_LLM_MODEL ?? "llama-3.1-8b-instant";

// Batch size — Groq context is large (128k tokens) so we can send all
// words in one shot for videos up to ~30 min. Split only for very long audio.
const BATCH_SIZE = 800;

// Path to user-corrections glossary (written by /api/glossary)
const GLOSSARY_PATH = join(process.cwd(), "glossary.json");

/** Read the local glossary.json (user corrections from caption editor). */
async function readLocalGlossary(): Promise<Record<string, string>> {
  try {
    if (!existsSync(GLOSSARY_PATH)) return {};
    const raw = await readFile(GLOSSARY_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Apply glossary corrections to a word (case-insensitive lookup).
 * Returns the corrected word if found, otherwise the original.
 */
function applyGlossary(word: string, glossary: Record<string, string>): string {
  const key = word.toLowerCase();
  return glossary[key] ?? word;
}


export function isHinglishLLMEnabled(): boolean {
  return !!process.env.GROQ_API_KEY;
}

/**
 * Detect if a string is predominantly Devanagari (needs transliteration).
 * Returns true when >30% of word characters are Devanagari codepoints.
 */
export function isDevanagari(text: string): boolean {
  const chars = [...text.replace(/\s/g, "")];
  if (chars.length === 0) return false;
  const devaCount = chars.filter(
    (c) => c >= "\u0900" && c <= "\u097F"
  ).length;
  return devaCount / chars.length > 0.3;
}

/**
 * Convert an array of Devanagari WhisperWords to Hinglish.
 * Timestamps are preserved; only `.word` text is replaced.
 * After LLM conversion, user corrections from glossary.json are applied.
 */
export async function transliterateWordsToHinglish(
  words: WhisperWord[]
): Promise<WhisperWord[]> {
  if (!words.length) return words;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  // Load user corrections (from caption editor) in parallel
  const [glossary, ...batches] = await Promise.all([
    readLocalGlossary(),
    // Process in batches so very long videos don't hit token limits
    ...chunkArray(words, BATCH_SIZE).map((batch) =>
      transliterateBatch(batch, apiKey)
    ),
  ]);

  const llmResult = batches.flat();

  // Apply user glossary corrections on top of LLM output
  const corrected = llmResult.map((w) => ({
    ...w,
    word: applyGlossary(w.word, glossary as Record<string, string>),
  }));

  const glossarySize = Object.keys(glossary as Record<string, string>).length;
  if (glossarySize > 0) {
    console.log(`[hinglish-llm] applied ${glossarySize} glossary corrections`);
  }

  return corrected;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}


async function transliterateBatch(
  words: WhisperWord[],
  apiKey: string
): Promise<WhisperWord[]> {
  // Build a numbered word list so the model returns in the same order
  const wordList = words
    .map((w, i) => `${i + 1}. ${w.word}`)
    .join("\n");

  const systemPrompt = `You are a Hindi-to-Hinglish transliterator for YouTube captions.
Convert each Hindi word (Devanagari script) to its natural Roman Hinglish spelling.

STRICT RULES:
- Output ONLY the transliterated words, one per line, numbered exactly like the input
- DO NOT translate — just write how the word is SPOKEN in everyday Hindi
- English words that appear in Hindi speech must stay in English as-is (transplant, clinic, FUE, FUT, natural, etc.)
- Use natural everyday Hinglish spellings, NOT academic IAST/ISO transliteration:
    अपनी  → apni        (NOT apani or apnī)
    क्योंकि → kyunki      (NOT kyonki)
    जाते  → jaate       (NOT jate)
    इन्होंने → unhone    (NOT inhonne)
    नहीं  → nahi        (NOT nahin)
    मुझे  → mujhe       (NOT mujhe is fine, but mujhE is NOT)
    बाल   → baal        (NOT bal)
    पहले  → pehle       (NOT pahale)
    हूँ   → hoon        (NOT hun or hu)
    मैं   → main        (NOT mai)
    वो/वह → woh
    ये/यह → yeh
- Numbers, punctuation, and already-Roman words: copy them unchanged
- Output exactly the same count of lines as the input`;

  const userPrompt = `Transliterate these Hindi words to Hinglish:\n\n${wordList}`;

  const t0 = Date.now();
  console.log(
    `[hinglish-llm] transliterating ${words.length} words via ${LLM_MODEL}...`
  );

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);

  let resp: Response;
  try {
    resp = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        max_tokens: words.length * 8, // ~4-6 tokens per Hinglish word
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("hinglish-llm: Groq request timed out after 30s");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`hinglish-llm: Groq ${resp.status}: ${body.slice(0, 200)}`);
  }

  interface GroqChatResp {
    choices: Array<{ message: { content: string } }>;
  }
  const data = (await resp.json()) as GroqChatResp;
  const raw = data.choices?.[0]?.message?.content ?? "";

  console.log(
    `[hinglish-llm] ok in ${Date.now() - t0}ms — raw sample: ${raw.slice(0, 120).replace(/\n/g, " | ")}`
  );

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Parse "N. word" lines — strip the leading "N. " prefix
  const transliterated: string[] = lines.map((line) => {
    // Match "123. word" or "123) word" or just "word"
    const m = line.match(/^\d+[.)]\s*(.+)$/);
    return m ? m[1].trim() : line;
  });

  // Map back to original words with timestamps preserved
  return words.map((w, i) => ({
    ...w,
    word: transliterated[i] ?? w.word, // fallback to original if LLM skipped
  }));
}

/**
 * Also transliterate the full text string (for the project's transcript_text field).
 */
export async function transliterateTextToHinglish(
  text: string
): Promise<string> {
  if (!text || !isDevanagari(text)) return text;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return text;

  const resp = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      max_tokens: 2048,
      messages: [
        {
          role: "system",
          content:
            "Convert the following Hindi text (Devanagari) to natural Hinglish (Roman script). " +
            "Write it as it would appear in YouTube captions — natural everyday spellings, " +
            "not academic transliteration. Keep English loanwords in English. " +
            "Output ONLY the Hinglish text, nothing else.",
        },
        { role: "user", content: text },
      ],
    }),
  });

  if (!resp.ok) return text;

  interface GroqResp { choices: Array<{ message: { content: string } }> }
  const data = (await resp.json()) as GroqResp;
  return data.choices?.[0]?.message?.content?.trim() ?? text;
}
