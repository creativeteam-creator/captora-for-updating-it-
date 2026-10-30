/**
 * Spoken-language catalogue + writing-script options for the upload modal.
 *
 * Covers Whisper's full 99-language set, grouped for the picker UX (Indic
 * weighted first — that's our audience). Each entry carries:
 *   - `code`: the Whisper language code we feed to the transcriber.
 *   - `nativeScript`: the script Whisper produces by default for this language.
 *   - `sanscriptScheme`: if set, the source-script name to feed to Sanscript
 *     for romanisation. `null` means we can't transliterate this language to
 *     Roman yet — the "Roman" option in the modal stays disabled.
 *   - `synthetic` (Hinglish only): pseudo-language that resolves to
 *     spoken=hindi + writingScript=roman behind the scenes.
 */

export type WritingScript = "native" | "roman";

/** Sanscript source-script names that we know work for the Indic languages we list. */
type SanscriptScheme =
  | "devanagari"
  | "bengali"
  | "gurmukhi"
  | "gujarati"
  | "tamil"
  | "telugu"
  | "kannada"
  | "malayalam"
  | "oriya";

export interface SpokenLanguage {
  code: string;
  label: string;
  nativeScript: string;
  /** When non-null, this language can be romanised via Sanscript. */
  sanscriptScheme: SanscriptScheme | null;
}

export interface SpokenLanguageGroup {
  label: string;
  languages: SpokenLanguage[];
}

/** Anything that can be transliterated to Roman — drives the writing-script toggle. */
export function supportsRoman(lang: SpokenLanguage): boolean {
  return lang.code === "english" || lang.sanscriptScheme !== null || hasLatinScript(lang);
}

function hasLatinScript(lang: SpokenLanguage): boolean {
  return lang.nativeScript === "Latin";
}

const indic: SpokenLanguage[] = [
  // Hinglish is a synthetic entry — no separate Whisper code. It always
  // resolves to spoken=hindi + writingScript=roman in `whisper.ts`.
  { code: "hi-roman", label: "Hinglish",  nativeScript: "Roman",       sanscriptScheme: "devanagari" },
  { code: "english",  label: "English",   nativeScript: "Latin",       sanscriptScheme: null },
  { code: "hindi",    label: "Hindi",     nativeScript: "Devanagari",  sanscriptScheme: "devanagari" },
  { code: "marathi",  label: "Marathi",   nativeScript: "Devanagari",  sanscriptScheme: "devanagari" },
  { code: "nepali",   label: "Nepali",    nativeScript: "Devanagari",  sanscriptScheme: "devanagari" },
  { code: "sanskrit", label: "Sanskrit",  nativeScript: "Devanagari",  sanscriptScheme: "devanagari" },
  { code: "bengali",  label: "Bengali",   nativeScript: "Bengali",     sanscriptScheme: "bengali" },
  { code: "assamese", label: "Assamese",  nativeScript: "Bengali",     sanscriptScheme: "bengali" },
  { code: "punjabi",  label: "Punjabi",   nativeScript: "Gurmukhi",    sanscriptScheme: "gurmukhi" },
  { code: "gujarati", label: "Gujarati",  nativeScript: "Gujarati",    sanscriptScheme: "gujarati" },
  { code: "tamil",    label: "Tamil",     nativeScript: "Tamil",       sanscriptScheme: "tamil" },
  { code: "telugu",   label: "Telugu",    nativeScript: "Telugu",      sanscriptScheme: "telugu" },
  { code: "kannada",  label: "Kannada",   nativeScript: "Kannada",     sanscriptScheme: "kannada" },
  { code: "malayalam",label: "Malayalam", nativeScript: "Malayalam",   sanscriptScheme: "malayalam" },
  { code: "sinhala",  label: "Sinhala",   nativeScript: "Sinhala",     sanscriptScheme: null },
  { code: "urdu",     label: "Urdu",      nativeScript: "Perso-Arabic",sanscriptScheme: null },
  { code: "sindhi",   label: "Sindhi",    nativeScript: "Perso-Arabic",sanscriptScheme: null },
  { code: "pashto",   label: "Pashto",    nativeScript: "Perso-Arabic",sanscriptScheme: null },
];

const eastAsian: SpokenLanguage[] = [
  { code: "chinese",   label: "Chinese (Mandarin)", nativeScript: "Hanzi",      sanscriptScheme: null },
  { code: "cantonese", label: "Cantonese",          nativeScript: "Hanzi",      sanscriptScheme: null },
  { code: "japanese",  label: "Japanese",           nativeScript: "Kana/Kanji", sanscriptScheme: null },
  { code: "korean",    label: "Korean",             nativeScript: "Hangul",     sanscriptScheme: null },
  { code: "vietnamese",label: "Vietnamese",         nativeScript: "Latin",      sanscriptScheme: null },
  { code: "thai",      label: "Thai",               nativeScript: "Thai",       sanscriptScheme: null },
  { code: "khmer",     label: "Khmer",              nativeScript: "Khmer",      sanscriptScheme: null },
  { code: "lao",       label: "Lao",                nativeScript: "Lao",        sanscriptScheme: null },
  { code: "burmese",   label: "Burmese",            nativeScript: "Burmese",    sanscriptScheme: null },
  { code: "indonesian",label: "Indonesian",         nativeScript: "Latin",      sanscriptScheme: null },
  { code: "malay",     label: "Malay",              nativeScript: "Latin",      sanscriptScheme: null },
  { code: "tagalog",   label: "Tagalog",            nativeScript: "Latin",      sanscriptScheme: null },
  { code: "javanese",  label: "Javanese",           nativeScript: "Latin",      sanscriptScheme: null },
  { code: "sundanese", label: "Sundanese",          nativeScript: "Latin",      sanscriptScheme: null },
  { code: "tibetan",   label: "Tibetan",            nativeScript: "Tibetan",    sanscriptScheme: null },
  { code: "mongolian", label: "Mongolian",          nativeScript: "Cyrillic",   sanscriptScheme: null },
];

const menaAndAfrica: SpokenLanguage[] = [
  { code: "arabic",    label: "Arabic",          nativeScript: "Arabic",       sanscriptScheme: null },
  { code: "hebrew",    label: "Hebrew",          nativeScript: "Hebrew",       sanscriptScheme: null },
  { code: "persian",   label: "Persian (Farsi)", nativeScript: "Perso-Arabic", sanscriptScheme: null },
  { code: "turkish",   label: "Turkish",         nativeScript: "Latin",        sanscriptScheme: null },
  { code: "amharic",   label: "Amharic",         nativeScript: "Ge'ez",        sanscriptScheme: null },
  { code: "swahili",   label: "Swahili",         nativeScript: "Latin",        sanscriptScheme: null },
  { code: "yoruba",    label: "Yoruba",          nativeScript: "Latin",        sanscriptScheme: null },
  { code: "hausa",     label: "Hausa",           nativeScript: "Latin",        sanscriptScheme: null },
  { code: "shona",     label: "Shona",           nativeScript: "Latin",        sanscriptScheme: null },
  { code: "somali",    label: "Somali",          nativeScript: "Latin",        sanscriptScheme: null },
  { code: "lingala",   label: "Lingala",         nativeScript: "Latin",        sanscriptScheme: null },
  { code: "malagasy",  label: "Malagasy",        nativeScript: "Latin",        sanscriptScheme: null },
];

const europeWest: SpokenLanguage[] = [
  { code: "spanish",      label: "Spanish",      nativeScript: "Latin", sanscriptScheme: null },
  { code: "french",       label: "French",       nativeScript: "Latin", sanscriptScheme: null },
  { code: "german",       label: "German",       nativeScript: "Latin", sanscriptScheme: null },
  { code: "italian",      label: "Italian",      nativeScript: "Latin", sanscriptScheme: null },
  { code: "portuguese",   label: "Portuguese",   nativeScript: "Latin", sanscriptScheme: null },
  { code: "dutch",        label: "Dutch",        nativeScript: "Latin", sanscriptScheme: null },
  { code: "swedish",      label: "Swedish",      nativeScript: "Latin", sanscriptScheme: null },
  { code: "danish",       label: "Danish",       nativeScript: "Latin", sanscriptScheme: null },
  { code: "norwegian",    label: "Norwegian",    nativeScript: "Latin", sanscriptScheme: null },
  { code: "nynorsk",      label: "Norwegian (Nynorsk)", nativeScript: "Latin", sanscriptScheme: null },
  { code: "finnish",      label: "Finnish",      nativeScript: "Latin", sanscriptScheme: null },
  { code: "icelandic",    label: "Icelandic",    nativeScript: "Latin", sanscriptScheme: null },
  { code: "faroese",      label: "Faroese",      nativeScript: "Latin", sanscriptScheme: null },
  { code: "luxembourgish",label: "Luxembourgish",nativeScript: "Latin", sanscriptScheme: null },
  { code: "catalan",      label: "Catalan",      nativeScript: "Latin", sanscriptScheme: null },
  { code: "galician",     label: "Galician",     nativeScript: "Latin", sanscriptScheme: null },
  { code: "basque",       label: "Basque",       nativeScript: "Latin", sanscriptScheme: null },
  { code: "occitan",      label: "Occitan",      nativeScript: "Latin", sanscriptScheme: null },
  { code: "breton",       label: "Breton",       nativeScript: "Latin", sanscriptScheme: null },
  { code: "welsh",        label: "Welsh",        nativeScript: "Latin", sanscriptScheme: null },
  { code: "maltese",      label: "Maltese",      nativeScript: "Latin", sanscriptScheme: null },
  { code: "latin",        label: "Latin",        nativeScript: "Latin", sanscriptScheme: null },
];

const europeEastSlavic: SpokenLanguage[] = [
  { code: "russian",   label: "Russian",   nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "ukrainian", label: "Ukrainian", nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "belarusian",label: "Belarusian",nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "polish",    label: "Polish",    nativeScript: "Latin",    sanscriptScheme: null },
  { code: "czech",     label: "Czech",     nativeScript: "Latin",    sanscriptScheme: null },
  { code: "slovak",    label: "Slovak",    nativeScript: "Latin",    sanscriptScheme: null },
  { code: "slovenian", label: "Slovenian", nativeScript: "Latin",    sanscriptScheme: null },
  { code: "croatian",  label: "Croatian",  nativeScript: "Latin",    sanscriptScheme: null },
  { code: "bosnian",   label: "Bosnian",   nativeScript: "Latin",    sanscriptScheme: null },
  { code: "serbian",   label: "Serbian",   nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "macedonian",label: "Macedonian",nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "bulgarian", label: "Bulgarian", nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "romanian",  label: "Romanian",  nativeScript: "Latin",    sanscriptScheme: null },
  { code: "albanian",  label: "Albanian",  nativeScript: "Latin",    sanscriptScheme: null },
  { code: "greek",     label: "Greek",     nativeScript: "Greek",    sanscriptScheme: null },
  { code: "hungarian", label: "Hungarian", nativeScript: "Latin",    sanscriptScheme: null },
  { code: "estonian",  label: "Estonian",  nativeScript: "Latin",    sanscriptScheme: null },
  { code: "latvian",   label: "Latvian",   nativeScript: "Latin",    sanscriptScheme: null },
  { code: "lithuanian",label: "Lithuanian",nativeScript: "Latin",    sanscriptScheme: null },
  { code: "armenian",  label: "Armenian",  nativeScript: "Armenian", sanscriptScheme: null },
  { code: "georgian",  label: "Georgian",  nativeScript: "Georgian", sanscriptScheme: null },
  { code: "azerbaijani",label:"Azerbaijani",nativeScript: "Latin",   sanscriptScheme: null },
  { code: "kazakh",    label: "Kazakh",    nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "uzbek",     label: "Uzbek",     nativeScript: "Latin",    sanscriptScheme: null },
  { code: "turkmen",   label: "Turkmen",   nativeScript: "Latin",    sanscriptScheme: null },
  { code: "tajik",     label: "Tajik",     nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "tatar",     label: "Tatar",     nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "bashkir",   label: "Bashkir",   nativeScript: "Cyrillic", sanscriptScheme: null },
  { code: "yiddish",   label: "Yiddish",   nativeScript: "Hebrew",   sanscriptScheme: null },
];

const otherIslands: SpokenLanguage[] = [
  { code: "afrikaans",     label: "Afrikaans",     nativeScript: "Latin", sanscriptScheme: null },
  { code: "haitian creole",label: "Haitian Creole",nativeScript: "Latin", sanscriptScheme: null },
  { code: "hawaiian",      label: "Hawaiian",      nativeScript: "Latin", sanscriptScheme: null },
  { code: "maori",         label: "Maori",         nativeScript: "Latin", sanscriptScheme: null },
];

export const SPOKEN_LANGUAGE_GROUPS: SpokenLanguageGroup[] = [
  { label: "Desi & Regional",       languages: indic },
  { label: "East Asian",            languages: eastAsian },
  { label: "Middle East & Africa",  languages: menaAndAfrica },
  { label: "European (Western)",    languages: europeWest },
  { label: "European (Slavic & East)", languages: europeEastSlavic },
  { label: "Other",                 languages: otherIslands },
];

const BY_CODE: Record<string, SpokenLanguage> = Object.fromEntries(
  SPOKEN_LANGUAGE_GROUPS.flatMap((g) => g.languages.map((l) => [l.code, l] as const))
);

export function getSpokenLanguage(code: string): SpokenLanguage | undefined {
  return BY_CODE[code];
}

/** Used by /api/transcribe + whisper.ts to look up the romanisation scheme. */
export function getSanscriptScheme(code: string): SanscriptScheme | null {
  return BY_CODE[code]?.sanscriptScheme ?? null;
}

/**
 * ISO 639-1 (or Whisper-compatible) language codes for every catalogue
 * entry, used as the language hint sent to Whisper-family STT providers
 * (Groq, faster-whisper) and ElevenLabs.
 *
 * Single source of truth — groq.ts, elevenlabs.ts, and faster-whisper.ts
 * each used to keep their own ~40-language subset of this table. Any
 * language missing from a provider's local copy got silently skipped
 * (`if (iso) form.append(...)`), so selecting e.g. Sanskrit, Sindhi, or
 * Pashto sent no language hint at all and Whisper fell back to
 * auto-detect with no warning surfaced anywhere.
 */
export const WHISPER_ISO_CODE: Record<string, string> = {
  "hi-roman": "hi",
  english: "en",       hindi: "hi",        marathi: "mr",      nepali: "ne",
  sanskrit: "sa",       bengali: "bn",      assamese: "as",     punjabi: "pa",
  gujarati: "gu",       tamil: "ta",        telugu: "te",       kannada: "kn",
  malayalam: "ml",      sinhala: "si",      urdu: "ur",         sindhi: "sd",
  pashto: "ps",
  chinese: "zh",        cantonese: "yue",   japanese: "ja",     korean: "ko",
  vietnamese: "vi",     thai: "th",         khmer: "km",        lao: "lo",
  burmese: "my",        indonesian: "id",   malay: "ms",        tagalog: "tl",
  javanese: "jw",       sundanese: "su",    tibetan: "bo",      mongolian: "mn",
  arabic: "ar",         hebrew: "he",       persian: "fa",      turkish: "tr",
  amharic: "am",        swahili: "sw",      yoruba: "yo",       hausa: "ha",
  shona: "sn",          somali: "so",       lingala: "ln",      malagasy: "mg",
  spanish: "es",        french: "fr",       german: "de",       italian: "it",
  portuguese: "pt",     dutch: "nl",        swedish: "sv",      danish: "da",
  norwegian: "no",      nynorsk: "nn",      finnish: "fi",      icelandic: "is",
  faroese: "fo",        luxembourgish: "lb",catalan: "ca",      galician: "gl",
  basque: "eu",         occitan: "oc",      breton: "br",       welsh: "cy",
  maltese: "mt",        latin: "la",
  russian: "ru",        ukrainian: "uk",    belarusian: "be",   polish: "pl",
  czech: "cs",          slovak: "sk",       slovenian: "sl",    croatian: "hr",
  bosnian: "bs",        serbian: "sr",      macedonian: "mk",   bulgarian: "bg",
  romanian: "ro",       albanian: "sq",     greek: "el",        hungarian: "hu",
  estonian: "et",       latvian: "lv",      lithuanian: "lt",   armenian: "hy",
  georgian: "ka",       azerbaijani: "az",  kazakh: "kk",       uzbek: "uz",
  turkmen: "tk",        tajik: "tg",        tatar: "tt",        bashkir: "ba",
  yiddish: "yi",
  afrikaans: "af",      "haitian creole": "ht", hawaiian: "haw", maori: "mi",
};

export const WRITING_SCRIPTS: Record<WritingScript, { label: string; hint: string }> = {
  native: {
    label: "Native script",
    hint: "Use the language's own script (Devanagari, Bengali, Hangul, etc.)",
  },
  roman: {
    label: "Roman script",
    hint: "Romanise non-Latin scripts (Hindi → Hinglish, Bengali → Roman, etc.)",
  },
};
