/**
 * Shared script post-processing — Indic native script (Devanagari, Bengali,
 * Tamil, …) → casual Roman ("Hinglish-style"). Extracted from `whisper.ts`
 * so every transcription provider (local Whisper, Sarvam, Groq) can reuse
 * the same conversion. Each provider returns raw native-script words; the
 * router decides whether to romanise them based on the user's settings.
 */

import Sanscript from "@indic-transliteration/sanscript";
import { getSanscriptScheme, type WritingScript } from "./languages";
import { resolveUserGlossary } from "./requestContext";
import type { WhisperWord } from "./whisper";

export interface RomanizationContext {
  spokenLanguage: string;
  writingScript?: WritingScript;
  translateToEnglish?: boolean;
}

/**
 * Decide whether the transcription should be romanised post-call, and if
 * so, which Sanscript source scheme to feed in.
 */
export function decideRomanization(ctx: RomanizationContext): {
  romanize: boolean;
  sourceScript: string | null;
} {
  if (ctx.translateToEnglish) return { romanize: false, sourceScript: null };
  if (ctx.spokenLanguage === "hi-roman") {
    return { romanize: true, sourceScript: "devanagari" };
  }
  if (ctx.writingScript === "roman") {
    const scheme = getSanscriptScheme(ctx.spokenLanguage);
    if (scheme) return { romanize: true, sourceScript: scheme };
  }
  return { romanize: false, sourceScript: null };
}

/**
 * Convert one Indic-script string to casual Roman. Sanscript's `optitrans`
 * gives the closest natural Roman, but still has ITRANS-style markers we
 * post-process away:
 *   - Capital letters for long vowels (A I U) and retroflex consonants
 *   - `M` / `.n` / `.m` / `~` for anusvar / nasalisation
 *   - Trailing `a` for the Sanskrit inherent schwa that Hindi mostly drops
 */
export function indicToRoman(text: string, sourceScript: string): string {
  let s = Sanscript.t(text, sourceScript, "optitrans");
  // Nasal markers → 'n'.
  s = s.replace(/\.[nm]/gi, "n");
  s = s.replace(/M/g, "n");
  s = s.replace(/~/g, "n");
  // Strip leftover structural dots (halant/visarga artefacts).
  s = s.replace(/\./g, "");
  // Salvage any leftover Devanagari (or other source-script) glyphs that
  // Sanscript didn't fully convert. Edge cases: rare consonant-vowel
  // combos, foreign-loanword phonemes, isolated diacritics like ़ (nukta)
  // that don't map to a single Roman letter. Without this pass the
  // captions show garbage like "gadhaोbhal" — half-Roman, half-Devanagari.
  // We approximate the most common stragglers and drop the rest.
  s = s
    .replace(/ो/g, "o")   // U+094B  vowel sign O (long o)
    .replace(/ौ/g, "au")  // U+094C  vowel sign AU
    .replace(/ी/g, "i")   // U+0940  vowel sign II (long i)
    .replace(/ि/g, "i")   // U+093F  vowel sign I
    .replace(/े/g, "e")   // U+0947  vowel sign E
    .replace(/ै/g, "ai")  // U+0948  vowel sign AI
    .replace(/ा/g, "a")   // U+093E  vowel sign AA
    .replace(/ु/g, "u")   // U+0941  vowel sign U
    .replace(/ू/g, "u")   // U+0942  vowel sign UU
    .replace(/ं/g, "n")   // U+0902  anusvara
    .replace(/ँ/g, "n")   // U+0901  candrabindu
    .replace(/्/g, "")    // U+094D  virama (silences inherent schwa)
    .replace(/़/g, "")    // U+093C  nukta (combining)
    .replace(/[^\x00-\x7F]/g, ""); // drop any remaining non-ASCII glyph
  // ── Medial schwa deletion — BEFORE lowercasing ────────────────────────
  // In Hindi, the inherent short schwa (lowercase 'a') is regularly deleted
  // in the middle of words. Long vowels stay uppercase (A I U) here so we
  // can safely drop only the short 'a' in high-confidence suffix patterns.
  //
  // We require at least 2 chars BEFORE the consonant+suffix so word-initial
  // vowels (like the 'a' in apani's first syllable) are NOT deleted.
  // "apani": a-p-[a]-n-i  → the [a] between p and n is at position 2 → safe.
  // Regex: \b\w{2,}[cons]-a-[suffix]\b  meaning the word must be ≥4 chars total.

  // Pronoun + postposition suffixes  (ap-ane, jin-ake, un-ake, is-ake …)
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])ane\b/g, "$1ne");
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])ani\b/g, "$1ni");
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])ana\b/g, "$1na");
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])ake\b/g, "$1ke");
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])aki\b/g, "$1ki");
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])ako\b/g, "$1ko");
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])aka\b/g, "$1ka");
  // Verb inflection suffixes  (sak-ate, dikh-ate, rah-ate …)
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])ate\b/g, "$1te");
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])ati\b/g, "$1ti");
  // -amen → -mein  (jisamen → jismein)
  s = s.replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])amen\b/g, "$1mein");

  // Word-final schwa deletion: lowercase `a` after a consonant when the
  // word is at least 3 chars long. Done BEFORE lowercasing so a real long
  // vowel `A` stays distinguishable.
  //   "tarUNa" → "tarUN"   (correct: तरुण = "tarun")
  //   "merA"   → "merA"    (kept: मेरा = "mera", final A is the long vowel)
  //   "AdhAra" → "AdhAr"   (correct: आधार = "adhar")
  s = s.replace(/(\S{2,}?[^aeiouAEIOU\s])a(?=\s|$|[.,;:!?])/g, "$1");
  return polishRomanHindi(s.toLowerCase());
}

/**
 * Convert Sanscript's academic-ish Roman into creator-friendly Hinglish.
 * Word fixes are ordered: longer/more-specific entries first so a
 * 2-word phrase like "nechrul luking" is matched before its parts.
 */
export function polishRomanHindi(text: string): string {
  let s = ` ${text} `;

  // ── Phrase fixes first (longer patterns before single-word) ─────────────
  const phraseFixes: Array<[RegExp, string]> = [
    // Medical / hair transplant phrases that Whisper mangles
    [/\bnechrul\s+luking\b/gi,        "natural looking"],
    [/\bnatural\s+luk(?:ing)?\b/gi,   "natural look"],
    [/\bhera\s+transplant\b/gi,       "hair transplant"],
    [/\bheyar?\s+transplant\b/gi,     "hair transplant"],
    [/\bhair\s+transplnt\b/gi,        "hair transplant"],
    [/\bhair\s+transpalnt\b/gi,       "hair transplant"],
    [/\bkyu\s+ech\s+ti\b/gi,          "QHT"],
    [/\bq\s*h\s*t\b/gi,               "QHT"],
    [/\bfu\s*e\b/gi,                  "FUE"],
    [/\bfu\s*t\b/gi,                  "FUT"],
    // Common Hinglish phrase patterns
    [/\bkya\s+hal\b/gi,               "kya haal"],
    [/\bkyun\s+ki\b/gi,               "kyunki"],
    [/\biss\s+liye\b/gi,              "isliye"],
    [/\bis\s+liye\b/gi,               "isliye"],
    [/\bbal\s+a\s+gaye\b/gi,          "baal aa gaye"],
    [/\bbal\s+gaye\b/gi,              "baal gaye"],
    [/\bbaal\s+a\s+gaye\b/gi,         "baal aa gaye"],
    [/\bpata\s+nahin\b/gi,            "pata nahi"],
    [/\bnahi\s+jamenge\b/gi,          "nahi jamenge"],
    [/\bkuche\s+nahin\b/gi,           "kuch nahi"],
    [/\bbal\s+chab\b/gi,              "baal chhab"],    // screenshot: "bal chab"
    [/\bbal\s+chap\b/gi,              "baal chhap"],
    [/\bdhul\s+dhakad\b/gi,           "dum dhaakad"],
    [/\bdhul\s+dhakd\b/gi,            "dum dhaakad"],
  ];
  for (const [pattern, to] of phraseFixes) {
    s = s.replace(pattern, to);
  }

  // ── Whole-word fixes ─────────────────────────────────────────────────────
  const wordFixes: Record<string, string> = {
    // Pronouns & common verbs
    "mai":          "main",
    "mein":         "mein",
    "men":          "mein",
    "me":           "mein",
    "hu":           "hoon",
    "hun":          "hoon",
    "hoo":          "hoon",
    "hain":         "hain",
    "tha":          "tha",
    "thi":          "thi",

    // Negation
    "nhi":          "nahi",
    "ni":           "nahi",
    "nai":          "nahi",
    "nahin":        "nahi",
    "nahi":         "nahi",

    // Question words
    "kyu":          "kyun",
    "kyun":         "kyun",
    "kyunki":       "kyunki",
    "kya":          "kya",

    // Common particles
    "aur":          "aur",
    "or":           "aur",
    "ki":           "ki",
    "ka":           "ka",
    "ke":           "ke",
    "ko":           "ko",
    "se":           "se",
    "ye":           "yeh",
    "yeh":          "yeh",
    "vo":           "woh",
    "voh":          "woh",
    "woh":          "woh",
    "toh":          "toh",
    "to":           "toh",
    "lekin":        "lekin",
    "par":          "par",
    "phir":         "phir",
    "fir":          "phir",
    "bhi":          "bhi",
    "isliye":       "isliye",
    "isiliye":      "isliye",

    // Body / hair related
    "bal":          "baal",
    "baal":         "baal",
    "sir":          "sir",
    "sira":         "sir",
    "siron":        "sir",
    "hairline":     "hairline",
    "donr":         "donor",
    "doner":        "donor",
    "donor":        "donor",
    "grafts":       "grafts",
    "greft":        "graft",
    "graft":        "graft",

    // Medical / treatment words that Whisper mangles
    "nechrul":      "natural",
    "nechral":      "natural",
    "nechril":      "natural",
    "nachrul":      "natural",
    "luking":       "looking",
    "luk":          "look",
    "transaplant":  "transplant",
    "trasplant":    "transplant",
    "transplnt":    "transplant",
    "treatmenta":   "treatment",
    "tritament":    "treatment",
    "tritamen":     "treatment",
    "tritment":     "treatment",
    "klinika":      "clinic",
    "klinik":       "clinic",
    "shootinguting":"shooting",
    "shootingting": "shooting",
    "lekhi":        "lekin",
    "leki":         "lekin",

    // ── optitrans formal Hindi → natural Hinglish ─────────────────────────
    // These are the most common romanisation artefacts seen in captions.
    // Conjunctions / connectors
    "kyonki":       "kyunki",   // क्योंकि
    // isliye / isiliye already mapped above (duplicate-safe)
    "aba":          "ab",       // अब  (optitrans adds trailing schwa)
    "taba":         "tab",      // तब
    "kaba":         "kab",      // कब
    "saba":         "sab",      // सब
    "yaba":         "yab",      // not common but safe
    "jaba":         "jab",      // जब
    "phaba":        "phab",
    "pahale":       "pehle",    // पहले
    "pahle":        "pehle",
    "pehale":       "pehle",

    // Verb forms (those not caught by suffix rules above)
    "inhonne":      "unhone",   // इन्होंने → unhone
    "unhonne":      "unhone",
    "karavaya":     "karwaya",  // करवाया
    "karavane":     "karvaane", // करवाने
    "karana":       "karna",    // करना  (caught by -ana rule but fallback)
    "karate":       "karte",    // करते  (careful: English "karate" stays — but Hinglish context ok)
    "karati":       "karti",
    "jaenge":       "jaenge",
    "rahenge":      "rahenge",
    "milenge":      "milenge",
    "jamenge":      "jamenge",
    "rahate":       "rahte",
    "rahati":       "rahti",
    "chahate":      "chahte",
    "chahati":      "chahti",
    "dikhate":      "dikhte",
    "dikhati":      "dikhti",
    "milate":       "milte",
    "milati":       "milti",
    "chalate":      "chalte",
    "chalati":      "chalti",
    "bolate":       "bolte",
    "bolati":       "bolti",
    "sunate":       "sunte",
    "sunati":       "sunti",
    "sakate":       "sakte",
    "sakati":       "sakti",
    "samajhate":    "samjhte",
    "batate":       "batate",   // बताते — keep (two real a's)

    // Pronouns + postpositions (those not caught by suffix rules)
    "apane":        "apne",
    "apani":        "apni",
    "apana":        "apna",
    "apako":        "apko",
    "apaka":        "apka",
    "apaki":        "apki",
    "jinake":       "jinke",
    "jinaki":       "jinki",
    "jinako":       "jinko",
    "jinaka":       "jinka",
    "unake":        "unke",
    "unaki":        "unki",
    "unako":        "unko",
    "unaka":        "unka",
    "isake":        "iske",
    "isaki":        "iski",
    "isako":        "isko",
    "isaka":        "iska",
    "inake":        "inke",
    "inaki":        "inki",
    "inako":        "inko",
    "inaka":        "inka",
    "jisake":       "jiske",
    "jisaki":       "jiski",
    "jisako":       "jisko",
    "jisaka":       "jiska",
    "jisamen":      "jisme",
    "usake":        "uske",
    "usaki":        "uski",
    "usako":        "usko",
    "usaka":        "uska",
    "kisake":       "kiske",
    "kisaki":       "kiski",
    "kisako":       "kisko",
    "kisaka":       "kiska",
    "hamane":       "humne",    // हमने
    "hamara":       "hamara",
    "hamari":       "hamari",
    "hamare":       "hamare",
    "tumhare":      "tumhare",
    "tumhari":      "tumhari",

    // Nouns commonly mangled by optitrans
    "ganjapana":    "ganjapan", // गंजापन
    "mahine":       "mahine",   // already correct, keep
    "samay":        "samay",
    // pahale already mapped above
    "chehara":      "chehra",   // चेहरा
    "chehra":       "chehra",
    "tampal":       "temple",   // temples → stay as English
    "densiti":      "density",  // density stay
    "framing":      "framing",  // facial framing stay

    // Creator / social-media words
    "doston":       "doston",
    "dosto":        "doston",
    "namaskar":     "namaskar",
    "namaste":      "namaste",
    "subscribe":    "subscribe",
    "subscrib":     "subscribe",
    "channel":      "channel",
    "video":        "video",

    // Misc proper nouns that romanize oddly
    "haridur":      "Haridwar",
    "haridvar":     "Haridwar",
    "srinagar":     "Srinagar",
    "gadarpur":     "Gadarpur",
    "nam":          "naam",
    "naam":         "naam",
    "vakt":         "waqt",
    "vakte":        "waqt",
    "vaqt":         "waqt",
  };

  for (const [from, to] of Object.entries(wordFixes)) {
    s = s.replace(new RegExp(`(?<=\\s)${escapeRegExp(from)}(?=\\s|[.,!?;:])`, "gi"), to);
  }

  s = applyGlossaryCorrections(s);
  return s.replace(/\s+/g, " ").trim();
}


/**
 * Glossary layers applied after romanisation, least to most specific:
 *
 *   1. built-in clinic glossary  (QHT terms, medical mishearings)
 *   2. CAPTORA_TRANSCRIPT_GLOSSARY="qhd=QHT, haridur=Haridwar"  (deployment)
 *   3. the signed-in user's own corrections from the captions list
 *
 * Layer 3 is the reason this list is ordered at all. This is the
 * optitrans fallback path — the one that runs when the Hinglish LLM is
 * unavailable or every provider has tripped its daily quota — and it
 * used to apply only layers 1 and 2. So on exactly the days the output
 * needed the most help, a user's own corrections were the thing that
 * went missing.
 */
function applyGlossaryCorrections(text: string): string {
  let s = text;

  // Built-in clinic glossary (QHT terms + medical mishearings) runs
  // first so its entries can be overridden by env-var configuration
  // if the operator ships a different mapping for the same key.
  // Lazy require via dynamic import isn't needed because clinicGlossary
  // has no runtime deps — the top-level import is safe.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CLINIC_GLOSSARY } = require("./clinicGlossary") as {
    CLINIC_GLOSSARY: Record<string, string>;
  };
  for (const [from, to] of Object.entries(CLINIC_GLOSSARY)) {
    s = s.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi"), to);
  }

  // Env-var overrides on top of the built-ins.
  const raw = process.env.CAPTORA_TRANSCRIPT_GLOSSARY ?? "";
  if (raw.trim()) {
    for (const entry of raw.split(",")) {
      const [fromRaw, toRaw] = entry.split("=");
      const from = fromRaw?.trim();
      const to = toRaw?.trim();
      if (!from || !to) continue;
      s = s.replace(
        new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi"),
        to
      );
    }
  }

  // The signed-in user's own corrections, last so they win over both
  // the built-ins and the deployment glossary — the user corrected the
  // word themselves, in this app, on their own content.
  for (const [from, to] of Object.entries(resolveUserGlossary())) {
    if (!from || !to) continue;
    s = s.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi"), to);
  }

  return s;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply romanisation to a full transcription result (words + text). Returns
 * a new object — input is not mutated.
 */
export function romaniseWords(
  words: WhisperWord[],
  sourceScript: string
): WhisperWord[] {
  return words.map((w) => ({
    ...w,
    word: indicToRoman(w.word, sourceScript),
  }));
}

export function romaniseText(text: string, sourceScript: string): string {
  return indicToRoman(text, sourceScript);
}
