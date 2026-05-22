/**
 * LLM-powered Hindi → Hinglish transliterator (multi-provider).
 *
 * Auto-priority (best Hindi accuracy first): Anthropic > OpenAI > Gemini > Groq.
 * Whichever API key is set wins; force one with HINGLISH_LLM_PROVIDER.
 *
 * Pipeline:
 *   1. Whisper / ElevenLabs transcribes audio → Devanagari (or rough Roman) words + timestamps
 *   2. This module batches those words → active LLM → clean Hinglish words
 *   3. Timestamps are preserved exactly — only the word text changes
 */

import type { WhisperWord } from "./whisper";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { indicToRoman } from "./script";

// ── Provider configuration ───────────────────────────────────────────────

type LLMProvider = "anthropic" | "openai" | "gemini" | "groq";

interface ProviderInfo {
  name: LLMProvider;
  apiKey: string;
  endpoint: string;
  model: string;
}

function pickProvider(): ProviderInfo {
  const forced = (process.env.HINGLISH_LLM_PROVIDER || "").toLowerCase().trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  // HINGLISH_LLM_MODEL only applies to the *currently picked* provider —
  // if the user pinned a provider via HINGLISH_LLM_PROVIDER, the override
  // is for that one. When the chain falls through to a different provider,
  // each provider uses its own default model (otherwise we'd send e.g.
  // "llama-3.3-70b-versatile" as the model id to Gemini and get a 404).
  const modelOverride = process.env.HINGLISH_LLM_MODEL;
  const overrideAppliesTo = (target: LLMProvider) =>
    forced === target ? modelOverride : undefined;

  const tryAnthropic = (): ProviderInfo | null =>
    anthropicKey
      ? {
          name: "anthropic",
          apiKey: anthropicKey,
          endpoint: "https://api.anthropic.com/v1/messages",
          model: overrideAppliesTo("anthropic") || "claude-sonnet-4-6",
        }
      : null;

  const tryOpenAI = (): ProviderInfo | null =>
    openaiKey
      ? {
          name: "openai",
          apiKey: openaiKey,
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: overrideAppliesTo("openai") || "gpt-4o",
        }
      : null;

  const tryGemini = (): ProviderInfo | null =>
    geminiKey
      ? {
          name: "gemini",
          apiKey: geminiKey,
          endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
          model: overrideAppliesTo("gemini") || "gemini-2.5-flash",
        }
      : null;

  const tryGroq = (): ProviderInfo | null =>
    groqKey
      ? {
          name: "groq",
          apiKey: groqKey,
          endpoint: "https://api.groq.com/openai/v1/chat/completions",
          model: overrideAppliesTo("groq") || "llama-3.3-70b-versatile",
        }
      : null;

  if (forced === "anthropic") { const p = tryAnthropic(); if (p) return p; }
  if (forced === "openai")    { const p = tryOpenAI();    if (p) return p; }
  if (forced === "gemini")    { const p = tryGemini();    if (p) return p; }
  if (forced === "groq")      { const p = tryGroq();      if (p) return p; }

  // Auto: walk down the priority list. Anthropic > OpenAI > Groq > Gemini.
  // Groq now sits above Gemini because Llama-3.3-70b follows our prompt's
  // example list more aggressively on rough-Roman English-loanword fixes
  // ("skul"/"heyar"/"arzund" → school/hair/around). Gemini Flash often
  // leaves these alone, mistaking them for already-clean Hinglish.
  return tryAnthropic() ?? tryOpenAI() ?? tryGroq() ?? tryGemini() ?? (() => {
    throw new Error(
      "hinglish-llm: no provider key configured " +
      "(set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY)"
    );
  })();
}

/**
 * Batch size scales with the active provider's per-minute capacity. Each
 * Hinglish batch uses ~6 tokens per word. Groq free-tier's 6000 TPM caps
 * us at 250 words; the paid providers + free Gemini handle much larger
 * batches so a long video can transliterate in 1-2 calls.
 */
function pickBatchSize(p: ProviderInfo): number {
  if (p.name === "anthropic") return 1500;
  if (p.name === "openai") return 1000;
  if (p.name === "gemini") {
    return /\bpro\b/i.test(p.model) ? 400 : 500;
  }
  // Groq Llama: 100 keeps the model from drifting on the format
  // (long lists make Llama drop or merge lines). The cleanup-pass below
  // catches anything still missed.
  return 100;
}

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
  return !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GROQ_API_KEY
  );
}

/**
 * Detect if a string is predominantly Devanagari (needs transliteration).
 * Returns true when >30% of word characters are Devanagari codepoints.
 */
export function isDevanagari(text: string): boolean {
  const chars = [...text.replace(/\s/g, "")];
  if (chars.length === 0) return false;
  const devaCount = chars.filter(
    (c) => c >= "ऀ" && c <= "ॿ"
  ).length;
  return devaCount / chars.length > 0.3;
}

// ── Unified LLM caller ────────────────────────────────────────────────────

interface CallResult {
  status: number;
  ok: boolean;
  text: string;
  retryAfterHeader: string | null;
  rawBody: string;
}

async function callLLM(
  p: ProviderInfo,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  signal: AbortSignal
): Promise<CallResult> {
  let headers: Record<string, string>;
  let body: string;
  let url = p.endpoint;

  if (p.name === "anthropic") {
    headers = {
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    body = JSON.stringify({
      model: p.model,
      max_tokens: maxTokens,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
  } else if (p.name === "gemini") {
    // Gemini's REST API takes the model in the path and the key as a
    // query param. systemInstruction is a separate top-level field.
    //
    // Thinking handling:
    //   - Gemini 2.5 Pro REQUIRES thinking (rejects budget=0). Default
    //     "auto" thinking can balloon to thousands of tokens and eats
    //     the maxOutputTokens budget — leaving an EMPTY visible answer.
    //     We pin thinkingBudget=2048 (enough for the model to reason)
    //     and bump maxOutputTokens to (visible-needed + thinking budget)
    //     so both fit.
    //   - Gemini 2.5 Flash: disable thinking entirely (rote substitution).
    url = `${p.endpoint}/${p.model}:generateContent?key=${p.apiKey}`;
    headers = { "content-type": "application/json" };
    const isPro = /\bpro\b/i.test(p.model);
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
    };
    if (isPro) {
      const PRO_THINKING_BUDGET = 2048;
      generationConfig.thinkingConfig = { thinkingBudget: PRO_THINKING_BUDGET };
      // Total budget = thinking + visible output. Pad visible by 50% so
      // longer Hinglish words / occasional rephrasing don't get cut off.
      generationConfig.maxOutputTokens = Math.ceil(maxTokens * 1.5) + PRO_THINKING_BUDGET;
    } else {
      generationConfig.maxOutputTokens = maxTokens;
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig,
    });
  } else {
    // OpenAI and Groq share the chat-completions wire format.
    headers = {
      Authorization: `Bearer ${p.apiKey}`,
      "Content-Type": "application/json",
    };
    body = JSON.stringify({
      model: p.model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
  }

  const resp = await fetch(url, { method: "POST", headers, body, signal });

  if (!resp.ok) {
    const rawBody = await resp.text();
    return {
      status: resp.status,
      ok: false,
      text: "",
      retryAfterHeader: resp.headers.get("retry-after"),
      rawBody,
    };
  }

  const data = await resp.json();
  let text = "";
  if (p.name === "anthropic") {
    type AnthropicResp = { content?: Array<{ type: string; text: string }> };
    const d = data as AnthropicResp;
    text = (d.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  } else if (p.name === "gemini") {
    type GeminiResp = {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const d = data as GeminiResp;
    text = (d.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");
  } else {
    type ChatResp = { choices?: Array<{ message?: { content?: string } }> };
    const d = data as ChatResp;
    text = d.choices?.[0]?.message?.content ?? "";
  }

  return { status: resp.status, ok: true, text, retryAfterHeader: null, rawBody: "" };
}

// ── Phonetic-English safety net ───────────────────────────────────────────
//
// Hardcoded map of common rough-Roman misspellings that ElevenLabs Scribe
// returns for English words spoken inside Hindi sentences. The Hinglish
// LLM polish step SHOULD catch these via its example prompt, but Gemini
// Flash in particular leaves them alone (it treats them as already-clean
// Hinglish). This runs AFTER the LLM polish as a last-mile defence.
//
// Inclusion rule: only entries whose source spelling has NO plausible
// Hindi/Hinglish meaning, so we never corrupt a real word. Match is
// case-insensitive but preserves the original casing in the output for
// proper nouns / sentence starts.
const PHONETIC_ENGLISH_FIXES: Record<string, string> = {
  // Hair clinic / consultation vocabulary
  heyar: "hair",
  heyars: "hairs",
  heyarlain: "hairline",
  phoal: "fall",
  fall: "fall",
  sarjari: "surgery",
  sarjeri: "surgery",
  sajari: "surgery",
  sajiri: "surgery",
  kanplit: "complete",
  kanpalit: "complete",
  kanplet: "complete",
  paramnent: "permanent",
  parmanent: "permanent",
  permanant: "permanent",
  rijalt: "result",
  rijalts: "results",
  rijult: "result",
  nechural: "natural",
  nechral: "natural",
  doaktar: "doctor",
  daktar: "doctor",
  klinik: "clinic",
  trasplant: "transplant",
  tritamen: "treatment",
  tritament: "treatment",
  menbar: "member",
  nanbar: "number",
  nunber: "number",
  tim: "team",
  groth: "growth",
  // Education / age
  skul: "school",
  tvelth: "twelfth",
  twelth: "twelfth",
  klass: "class",
  // Common conversational English borrowings
  proablam: "problem",
  problam: "problem",
  prablum: "problem",
  yutyub: "youtube",
  yutub: "youtube",
  yuttube: "youtube",
  stoak: "stock",
  istok: "stock",
  kyusiti: "quality",
  kuwaliti: "quality",
  kantiti: "quantity",
  bennifit: "benefit",
  benefits: "benefits",
  arzund: "around",
  araund: "around",
  altaranet: "alternate",
  altarnate: "alternate",
  oapshn: "option",
  opshan: "option",
  oapshan: "option",
  rekomend: "recommend",
  rekomand: "recommend",
  salamost: "almost",
  almoast: "almost",
  consalt: "consult",
  consaltent: "consultant",
  konsultant: "consultant",
  apoinment: "appointment",
  appoinment: "appointment",
  apointment: "appointment",
  customar: "customer",
  kasturmar: "customer",
  folowup: "follow-up",
  follouap: "follow-up",
  karyar: "career",
  kariyar: "career",
  bisness: "business",
  klient: "client",
  feis: "face",
  fais: "face",
  // Misc misspellings the LLM sometimes leaves through
  yutyub_p: "youtube par",
};

/**
 * Apply the phonetic-English safety net to a single word. Preserves
 * leading capitalisation (so a sentence-start "Skul" becomes "School").
 * Returns the input unchanged when no mapping matches.
 */
function applyPhoneticEnglishFix(word: string): string {
  if (!word) return word;
  // Strip a single trailing punctuation mark for lookup but reattach
  // it to the output, so "skul," becomes "school,".
  const m = word.match(/^([\p{L}\p{N}'-]+)([^\p{L}\p{N}'-]?)$/u);
  const core = m ? m[1] : word;
  const tail = m ? m[2] : "";
  const lower = core.toLowerCase();
  const replacement = PHONETIC_ENGLISH_FIXES[lower];
  if (!replacement) return word;
  // Preserve initial capitalisation on the replacement.
  const cased =
    core[0] === core[0]?.toUpperCase() && core !== lower
      ? replacement[0].toUpperCase() + replacement.slice(1)
      : replacement;
  return cased + tail;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Build the priority chain of providers we'll try if the primary fails
 * permanently (after its own retry budget). Honour an explicit
 * HINGLISH_LLM_PROVIDER override (single provider, no fallback) so users
 * can pin one for testing.
 */
function buildProviderChain(): ProviderInfo[] {
  const forced = (process.env.HINGLISH_LLM_PROVIDER || "").toLowerCase().trim();
  const chain: ProviderInfo[] = [];
  const seen = new Set<LLMProvider>();
  const tryAddOne = (envName: "anthropic" | "openai" | "gemini" | "groq") => {
    process.env.HINGLISH_LLM_PROVIDER = envName;
    try {
      const p = pickProvider();
      if (!seen.has(p.name)) {
        chain.push(p);
        seen.add(p.name);
      }
    } catch { /* no key for this one — skip */ }
  };
  const original = process.env.HINGLISH_LLM_PROVIDER;
  try {
    // Forced provider goes first if specified — but we still build the
    // rest of the chain after it so a hard failure (daily-quota, account
    // suspension, network out) automatically falls through to whatever
    // other keys are configured. "Force" here means "prefer this", not
    // "use ONLY this".
    if (forced === "anthropic" || forced === "openai" || forced === "gemini" || forced === "groq") {
      tryAddOne(forced);
    }
    // Default priority for the remaining slots. Paid providers first,
    // then **Groq before Gemini**: in production we found Gemini Flash
    // leaves common English loanwords as their rough phonetic Roman
    // ("skul", "heyar", "arzund", "altaranet", "oapshn", "rekomend"…)
    // because it interprets them as already-clean Hinglish. Llama-3.3-
    // 70b on Groq follows the prompt's example list more aggressively
    // and actually converts them to school / hair / around / etc.
    // Gemini stays in the chain as a hot standby for when Groq's
    // daily-token quota trips.
    tryAddOne("anthropic");
    tryAddOne("openai");
    tryAddOne("groq");
    tryAddOne("gemini");
  } finally {
    if (original === undefined) delete process.env.HINGLISH_LLM_PROVIDER;
    else process.env.HINGLISH_LLM_PROVIDER = original;
  }
  return chain;
}

export async function transliterateWordsToHinglish(
  words: WhisperWord[]
): Promise<WhisperWord[]> {
  if (!words.length) return words;

  const chain = buildProviderChain();
  if (chain.length === 0) {
    throw new Error(
      "hinglish-llm: no provider key configured " +
      "(set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY)"
    );
  }

  // Walk down the chain — try each provider's full retry budget for the
  // batch before falling through to the next provider. This lets us
  // recover from a single overloaded provider (Gemini's 503 spikes,
  // Anthropic credit exhaustion mid-job, etc.) without dropping all the
  // way to the optitrans regex fallback.
  let lastErr: unknown = null;
  for (let providerIdx = 0; providerIdx < chain.length; providerIdx++) {
    const provider = chain[providerIdx];
    const batchSize = pickBatchSize(provider);
    console.log(
      `[hinglish-llm] using provider=${provider.name} model=${provider.model} batch=${batchSize}` +
      (providerIdx > 0 ? ` (fallback #${providerIdx} after previous provider failed)` : "")
    );

    try {
      const glossaryPromise = readLocalGlossary();
      const chunks = chunkArray(words, batchSize);
      const llmResult: WhisperWord[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const batch = await transliterateBatch(chunks[i], provider);
        llmResult.push(...batch);
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // ── Cleanup pass for skipped words ────────────────────────────
      // transliterateBatch leaves Devanagari in slots the LLM skipped.
      // Send those alone in a fresh batch — the model usually transliterates
      // correctly when there's no other context to drift toward. Repeat
      // up to 2 cleanup rounds so half-fixes also get retried.
      const stillDeva = (w: WhisperWord) => /[ऀ-ॿ]/.test(w.word);
      for (let pass = 0; pass < 2; pass++) {
        const skippedIndices: number[] = [];
        for (let i = 0; i < llmResult.length; i++) {
          if (stillDeva(llmResult[i])) skippedIndices.push(i);
        }
        if (skippedIndices.length === 0) break;
        console.log(
          `[hinglish-llm] cleanup pass ${pass + 1}: ${skippedIndices.length} words still Devanagari, retrying via ${provider.name}...`
        );
        const skippedWords = skippedIndices.map((idx) => llmResult[idx]);
        try {
          const cleanup = await transliterateBatch(skippedWords, provider);
          cleanup.forEach((w, j) => {
            llmResult[skippedIndices[j]] = w;
          });
        } catch (err) {
          console.warn(
            `[hinglish-llm] cleanup pass ${pass + 1} failed: ` +
            (err instanceof Error ? err.message : err)
          );
          break;
        }
      }

      // Final fallback: optitrans regex for any word the LLM never
      // managed to transliterate (after main pass + cleanup retries).
      // Better academic-style spelling than blank captions.
      let finalOptitransCount = 0;
      for (let i = 0; i < llmResult.length; i++) {
        if (stillDeva(llmResult[i])) {
          llmResult[i] = {
            ...llmResult[i],
            word: indicToRoman(llmResult[i].word, "devanagari"),
          };
          finalOptitransCount++;
        }
      }
      if (finalOptitransCount > 0) {
        console.log(
          `[hinglish-llm] applied optitrans regex fallback to ${finalOptitransCount} words ` +
          `the LLM couldn't transliterate after ${2 + 1} passes`
        );
      }

      // Phonetic-English safety net — catches common rough-Roman
      // misspellings of English words that BOTH Gemini Flash and Groq
      // sometimes leave alone because the input "looks Hinglish-y".
      // Only includes mappings where the source has no plausible Hindi
      // meaning, so no false positives on real Hindi words.
      let safetyNetCount = 0;
      for (let i = 0; i < llmResult.length; i++) {
        const fixed = applyPhoneticEnglishFix(llmResult[i].word);
        if (fixed !== llmResult[i].word) {
          llmResult[i] = { ...llmResult[i], word: fixed };
          safetyNetCount++;
        }
      }
      if (safetyNetCount > 0) {
        console.log(
          `[hinglish-llm] phonetic-english safety net fixed ${safetyNetCount} word(s) the LLM left as rough Roman`
        );
      }

      const glossary = await glossaryPromise;
      const corrected = llmResult.map((w) => ({
        ...w,
        word: applyGlossary(w.word, glossary as Record<string, string>),
      }));
      const glossarySize = Object.keys(glossary as Record<string, string>).length;
      if (glossarySize > 0) {
        console.log(`[hinglish-llm] applied ${glossarySize} glossary corrections`);
      }
      return corrected;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[hinglish-llm] provider=${provider.name} failed after retries: ` +
        `${err instanceof Error ? err.message : err}` +
        (providerIdx < chain.length - 1 ? "; falling through to next provider" : "; no more providers")
      );
      // Loop continues with next provider in the chain.
    }
  }

  // Every provider in the chain failed. Surface the last error so the
  // router can fall back to the optitrans regex path as a last resort.
  throw lastErr instanceof Error
    ? lastErr
    : new Error("hinglish-llm: all providers failed");
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Parse the "retry after" hint from a 429 body. Providers like Groq
 * return messages such as "Please try again in 27.5s" — pull that out
 * so we can wait the exact suggested duration.
 */
function parseRetryAfterSeconds(body: string, headerVal: string | null): number {
  if (headerVal) {
    const n = parseFloat(headerVal);
    if (!Number.isNaN(n) && n > 0) return Math.min(n, 60);
  }
  const m = body.match(/try again in ([0-9]+(?:\.[0-9]+)?)s/i);
  if (m) {
    const n = parseFloat(m[1]);
    if (!Number.isNaN(n) && n > 0) return Math.min(n + 1, 60);
  }
  return 30;
}

async function transliterateBatch(
  words: WhisperWord[],
  provider: ProviderInfo,
  retryCount = 0
): Promise<WhisperWord[]> {
  const wordList = words.map((w, i) => `${i + 1}. ${w.word}`).join("\n");

  const systemPrompt = `You are a Hinglish caption normaliser. Inputs are either Hindi
words (Devanagari script) OR rough Roman transcriptions from a speech-to-text model
that has phonetic errors. Output the SAME count of lines, numbered exactly like input,
with each word converted to natural everyday Hinglish.

THREE INPUT CASES:
1. Devanagari → transliterate to Roman Hinglish (natural spelling, not academic IAST)
2. Rough Roman from STT (phonetic / wrong spelling) → fix to natural Hinglish or English
3. Already-clean English / Hinglish word → copy unchanged

OUTPUT FORMAT — extremely strict:
- NO preamble, NO explanation, NO "Here is the transliteration:" header.
- Begin the very first line with "1." — nothing else before it.
- One line per input word, numbered "1.", "2.", "3." etc.
- After the number put ONLY the final Hinglish word — no arrows, no Devanagari,
  no parentheses, no notes.
  CORRECT:   1. mera
  WRONG:     1. मेरा → mera
  WRONG:     1. mera (mine)
  WRONG:     Here are the transliterations:\n1. mera
- DO NOT translate — write how the word is SPOKEN in everyday Hindi
- English loanwords MUST be in clean English: transplant, clinic, doctor, member,
  number, team, hospital, treatment, natural, FUE, FUT, etc.
- Numbers stay as digits

DEVANAGARI EXAMPLES:
    अपनी  → apni        (NOT apani or apnī)
    क्योंकि → kyunki      (NOT kyonki)
    जाते  → jaate       (NOT jate)
    इन्होंने → unhone    (NOT inhonne)
    नहीं  → nahi        (NOT nahin)
    मुझे  → mujhe
    बाल   → baal        (NOT bal)
    पहले  → pehle       (NOT pahale)
    हूँ   → hoon        (NOT hun)
    मैं   → main        (NOT mai)
    वो/वह → woh
    ये/यह → yeh

ENGLISH LOANWORD RULE (critical):
Hindi speakers often use English words mid-sentence. When the input
LOOKS like phonetic Devanagari spelling of an English word, OUTPUT THE
ENGLISH WORD (not the phonetic Hinglish). This is the most common
caption error to catch.

DEVANAGARI → ENGLISH LOANWORDS (NEVER transliterate these phonetically):
    हेयर       → hair          (NOT heyar)
    हेयरलाइन   → hairline      (NOT heyarlain)
    हेयरस्टाइल → hairstyle
    लाइन       → line          (NOT lain)
    ट्रांसप्लांट → transplant    (NOT trasplant)
    क्लीनिक    → clinic         (NOT klinik)
    डॉक्टर     → doctor         (NOT doaktar / daktar)
    रिज़ल्ट    → result         (NOT rijalt / rijalts)
    रिज़ल्ट्स  → results
    हंड्रेड    → hundred        (NOT handret)
    परसेंट     → percent        (NOT parasent / parsent)
    नेचुरल    → natural         (NOT nechural / nechral)
    प्योर      → pure           (NOT pyor)
    ग्रोथ      → growth         (NOT groth)
    शूटिंग    → shooting        (NOT shuting)
    मेकअप      → makeup         (NOT mekap)
    सेशन       → session
    प्रोसीजर   → procedure
    ट्रीटमेंट  → treatment       (NOT tritamen)
    टीम        → team           (NOT tim)
    मेंबर      → member          (NOT menbar)
    नंबर       → number          (NOT nanbar / nunber)
    एफयूई      → FUE
    एफयूटी     → FUT
    डीएचटी     → DHT
    पीआरपी     → PRP
    जीएफसी     → GFC
    लूकिंग     → looking         (NOT luking)
    ग्राफ्ट   → graft            (NOT greft)
    फॉलिकल    → follicle
    हेयरट्रांसप्लांट → hair transplant

PROPER NOUNS (preserve standard English/Hinglish spelling):
    रजपाल / रजपाल यादव → Rajpal Yadav     (NOT rajapal)
    तरुण वधवान         → Tarun Vadhwan
    क्यूएचटी / क्यू एच टी / क्यूएचटीक्लिनिक → QHT / QHT Clinic
    हरिद्वार           → Haridwar         (NOT haridur / haridvar)
    श्रीनगर            → Srinagar
    गदरपुर             → Gadarpur
    देहरादून           → Dehradun

DEVANAGARI HINDI EXAMPLES (use natural Hinglish, not academic IAST):
    अपनी    → apni        (NOT apani)
    क्योंकि → kyunki       (NOT kyonki)
    जाते    → jaate
    इन्होंने → unhone
    नहीं    → nahi
    मुझे    → mujhe
    बाल     → baal
    पहले    → pehle
    हूँ     → hoon
    मैं     → main
    वो/वह   → woh
    ये/यह   → yeh
    आइना    → aaina        (NOT aine)
    महसूस   → mehsoos      (NOT mahasus)
    चार     → char          (NOT chau)
    कटवाने / कटवाना → katwane / katwana   (NOT kathavane)
    वजह     → wajah          (NOT bajae)
    असली    → asli           (NOT asali)
    जमेंगे  → jamenge
    धूल     → dhool          (NOT dhul)
    धक्कड़ → dhakkad
    एकदम    → ekdam          (NOT ekadam)
    बिल्कुल → bilkul

ROUGH-ROMAN INPUT FIX EXAMPLES (when input is already Roman but mis-spelled):
    aine     → aaina
    mahasus  → mehsoos
    doaktar  → doctor
    heyar    → hair
    rijalt   → result
    nechural → natural
    handret  → hundred
    parasent → percent
    pyor     → pure
    groth    → growth
    shuting  → shooting
    lain     → line
    rajapal  → Rajpal
    kathavane → katwane
    bajae    → wajah          (when context is "wajah se" / "vajah se")
    asali    → asli
    bal      → baal
    thodaa   → thoda
    transplant → transplant   (already correct, keep)

ROUGH-ROMAN ENGLISH-LOAN FIXES (clinic / consultation context — these are
SPOKEN as English words inside Hindi sentences, so the output MUST be the
clean English spelling, never the phonetic Roman):
    sarjari   → surgery
    sarjeri   → surgery
    kanplit   → complete
    kanpalit  → complete
    kanplet   → complete
    proablam  → problem
    problam   → problem
    prablum   → problem
    yutyub    → youtube
    yutub     → youtube
    yutub p   → youtube par
    stoak     → stock
    istok     → stock
    kyusiti   → quality        (default; could be "city" — pick from context)
    kuwaliti  → quality
    kantiti   → quantity
    benefit   → benefit
    bennifit  → benefit
    benefits  → benefits
    balles    → bald
    bals      → bald
    bald      → bald            (already correct, keep)
    rijalts   → results
    rijult    → result
    paramnent → permanent
    parmanent → permanent
    permanant → permanent
    badhaiya  → badhiya         (Hindi "great" — keep as Hinglish, do not translate)
    badhaya   → badhiya
    matalab   → matlab          (Hindi "meaning" — common spelling fix)
    matlb     → matlab
    soochna   → soochna
    sohcha    → socha
    mainne    → maine           (common "I" form fix)
    yeh hi    → yahi            (common contraction)
    consalt   → consult
    consaltent → consultant
    konsultant → consultant
    tin       → teen            (when context is the number 3, not English "tin")
    fais      → face
    feis      → face
    apoint    → appoint
    apoinment → appointment
    appoinment → appointment
    karyar    → career
    kariyar   → career
    bisness   → business
    klient    → client
    customar  → customer
    kasturmar → customer
    follow    → follow           (already correct)
    follouap  → follow-up
    folowup   → follow-up
    sajiri    → surgery
    sajari    → surgery`;

  const userPrompt = `Transliterate these Hindi words to Hinglish:\n\n${wordList}`;

  const t0 = Date.now();
  console.log(
    `[hinglish-llm] transliterating ${words.length} words via ${provider.model}...`
  );

  // Generous timeout — Gemini Pro with thinking on a 400-word batch
  // can run ~30-60s; Anthropic / OpenAI similar. Router-level fallback
  // handles persistent failures so this is just a safety stop.
  const ctrl = new AbortController();
  const timeoutMs = provider.name === "gemini" && /\bpro\b/i.test(provider.model)
    ? 180_000  // 3 min for Gemini Pro (thinking is mandatory and slow)
    : 60_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let resp: CallResult;
  try {
    resp = await callLLM(provider, systemPrompt, userPrompt, words.length * 8, ctrl.signal);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`hinglish-llm: ${provider.name} request timed out after 60s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    // Detect *daily* quota exhaustion vs *per-minute* throttling.
    // TPD (tokens-per-day) / RPD (requests-per-day) reset is hours
    // away — retrying with a 60s back-off just wastes time. Bail out
    // immediately so the chain falls through to the next provider.
    const isDailyQuota =
      /tokens?\s+per\s+day|\bTPD\b|requests?\s+per\s+day|\bRPD\b|\bquota exceeded\b|\bbillin\w+ details\b|\binsufficient_quota\b/i
        .test(resp.rawBody);

    if (isDailyQuota) {
      console.log(
        `[hinglish-llm] ${provider.name} ${resp.status} daily quota exhausted ` +
        `— skipping retries, falling through to next provider`
      );
      throw new Error(
        `hinglish-llm: ${provider.name} daily quota exhausted: ${resp.rawBody.slice(0, 200)}`
      );
    }

    // Retry on transient failures:
    //   429              = per-minute rate-limit (TPM cap)
    //   502 / 503 / 504  = upstream / overload (Gemini's "high demand" 503,
    //                       OpenAI gateway 502, etc.)
    // Wait time: providers that send a hint use it; otherwise exponential
    // back-off (5s, 15s, 45s).
    const transient = resp.status === 429 || (resp.status >= 502 && resp.status <= 504);
    if (transient && retryCount < 3) {
      const waitSec =
        resp.status === 429
          ? parseRetryAfterSeconds(resp.rawBody, resp.retryAfterHeader)
          : Math.min(5 * Math.pow(3, retryCount), 60);
      const reason = resp.status === 429 ? "rate-limit" : "overload";
      console.log(
        `[hinglish-llm] ${provider.name} ${resp.status} (${reason}); ` +
        `waiting ${waitSec}s then retrying batch (attempt ${retryCount + 2}/4)...`
      );
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      return transliterateBatch(words, provider, retryCount + 1);
    }
    throw new Error(`hinglish-llm: ${provider.name} ${resp.status}: ${resp.rawBody.slice(0, 200)}`);
  }

  const raw = resp.text;
  console.log(
    `[hinglish-llm] ok in ${Date.now() - t0}ms — raw sample: ${raw.slice(0, 120).replace(/\n/g, " | ")}`
  );

  // Robust line parser. Models in practice use varied output formats:
  //   "1. word"     (ideal)
  //   "1) word"
  //   "1: word"
  //   "1 - word"
  //   "1 word"      (just whitespace)
  //   "1. **word**" (bold markdown)
  // Plus they sometimes inject preamble ("Here is the transliteration:"),
  // arrow notation ("1. मेरा → mera"), or parenthetical glosses. We:
  //   1. accept any of the above separators between leading number and content
  //   2. align by the actual line number (so omissions don't shift later words)
  //   3. strip any "<source> → <target>" — keep only the rightmost segment
  //   4. strip markdown bold/italic markers
  //   5. strip trailing parenthetical glosses like "(mine)", "(mirror)"
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const transliterated: (string | null)[] = new Array(words.length).fill(null);
  for (const line of lines) {
    // Leading number followed by ., ), :, -, or just whitespace.
    const m = line.match(/^(\d+)\s*[.):\-—–]?\s+(.+)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    if (idx < 0 || idx >= words.length) continue;

    let value = m[2].trim();
    // Strip "<source> → <target>" — keep only the last segment after
    // the rightmost arrow. Handles → (U+2192), -> and =>.
    const arrowMatch = value.match(/^.*?(?:→|->|=>)\s*(.+)$/);
    if (arrowMatch) value = arrowMatch[1].trim();
    // Strip markdown emphasis (* __ etc.)
    value = value.replace(/^[*_`]+|[*_`]+$/g, "").trim();
    // Strip trailing "(notes)" parenthetical
    value = value.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!value) continue;
    transliterated[idx] = value;
  }

  // Diagnostic: if we got fewer numbered lines than expected, log so we
  // can spot output-truncation regressions.
  const numberedLineCount = transliterated.filter((v) => v !== null).length;
  if (numberedLineCount < words.length) {
    console.log(
      `[hinglish-llm] parsed ${numberedLineCount}/${words.length} numbered lines ` +
      `from ${provider.name} output (${lines.length} non-blank lines total)`
    );
  }

  // For any slot the LLM skipped (numbered line missing or empty),
  // KEEP the original (Devanagari) word for now and let the caller
  // handle it. The caller does a cleanup pass — sending the skipped
  // words alone to the same LLM with a fresh prompt — before falling
  // through to optitrans regex. This catches LLM output drift on long
  // batches where a few lines get merged or dropped.
  let skippedCount = 0;
  const out = words.map((w, i) => {
    if (transliterated[i]) return { ...w, word: transliterated[i] as string };
    skippedCount++;
    return w; // keep original — caller will retry / fall back
  });
  if (skippedCount > 0) {
    console.log(
      `[hinglish-llm] LLM skipped ${skippedCount}/${words.length} words ` +
      `(caller will retry / optitrans-fallback)`
    );
  }
  return out;
}

/**
 * Also transliterate the full text string (for the project's transcript_text field).
 */
export async function transliterateTextToHinglish(text: string): Promise<string> {
  if (!text || !isDevanagari(text)) return text;

  let provider: ProviderInfo;
  try {
    provider = pickProvider();
  } catch {
    return text;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const resp = await callLLM(
      provider,
      "Convert the following Hindi text (Devanagari) to natural Hinglish (Roman script). " +
        "Write it as it would appear in YouTube captions — natural everyday spellings, " +
        "not academic transliteration. Keep English loanwords in English. " +
        "Output ONLY the Hinglish text, nothing else.",
      text,
      2048,
      ctrl.signal
    );
    if (!resp.ok) return text;
    return resp.text.trim() || text;
  } catch {
    return text;
  } finally {
    clearTimeout(timer);
  }
}
