/**
 * Built-in glossary corrections for QHT Clinic content — hair-transplant
 * medical terms + proper nouns + common mishearings the STT + Hinglish
 * polish chain repeatedly gets wrong on clinic recordings.
 *
 * Merged with user-added corrections at transcript time so every user
 * gets these fixes without touching the Settings panel. The user's own
 * corrections still WIN over these defaults if they overlap (the merge
 * puts user entries second so they override).
 *
 * Keep additions short + focused — a broad glossary starts corrupting
 * unrelated words. Only add a term when you've seen it come out
 * consistently wrong in at least one real clinic recording.
 */

/**
 * Case-insensitive substitution table. Left side = what the STT emits;
 * right side = what should end up in the caption. Applied at word-
 * boundaries so partial matches inside longer words don't fire.
 */
export const CLINIC_GLOSSARY: Record<string, string> = {
  // ── Brand ─────────────────────────────────────────────────────────
  "qhd":              "QHT",
  "qht":              "QHT",
  "kyu ech ti":       "QHT",
  "klinik":           "Clinic",
  "klinika":          "Clinic",

  // ── Locations (QHT branches + nearby cities) ─────────────────────
  "haridur":          "Haridwar",
  "haridvar":         "Haridwar",
  "haridwar":         "Haridwar",
  "srinagar":         "Srinagar",
  "gadarpur":         "Gadarpur",
  "gadabal":          "Gadarpur",
  "gadibal":          "Gadarpur",
  "dehradun":         "Dehradun",
  "dehradoon":        "Dehradun",
  "roorkee":          "Roorkee",
  "rurki":            "Roorkee",
  "rishikesh":        "Rishikesh",

  // ── Clinicians / staff (proper nouns Whisper commonly butchers) ──
  "tarun":            "Tarun",
  "vadhwan":          "Vadhwan",
  "vadwan":           "Vadhwan",
  "rajpal":           "Rajpal",
  "yadav":            "Yadav",

  // ── Procedures ───────────────────────────────────────────────────
  "hera transplant":       "hair transplant",
  "heyar transplant":      "hair transplant",
  "hair transplant":       "hair transplant",
  "trasplant":             "transplant",
  "transaplant":           "transplant",
  "transplant":            "transplant",
  "fue":                   "FUE",
  "fut":                   "FUT",
  "dht":                   "DHT",
  "prp":                   "PRP",
  "gfc":                   "GFC",
  "mesotherapy":           "mesotherapy",
  "mesothrapy":            "mesotherapy",

  // ── Medications ──────────────────────────────────────────────────
  "finasteride":           "Finasteride",
  "phinasteride":          "Finasteride",
  "finasterid":            "Finasteride",
  "minoxidil":             "Minoxidil",
  "minoxydil":             "Minoxidil",
  "minoxadil":             "Minoxidil",
  "rogaine":               "Rogaine",
  "propecia":              "Propecia",
  "dutasteride":           "Dutasteride",

  // ── Anatomy / clinical terms ─────────────────────────────────────
  "greft":                 "graft",
  "grefts":                "grafts",
  "graft":                 "graft",
  "grafts":                "grafts",
  "folicle":               "follicle",
  "folicles":              "follicles",
  "follicle":              "follicle",
  "follicles":             "follicles",
  "donr":                  "donor",
  "doner":                 "donor",
  "recipient":             "recipient",
  "hairline":              "hairline",
  "heyarline":             "hairline",
  "density":               "density",
  "alopecia":              "alopecia",
  "alopesia":              "alopecia",
  "baldness":              "baldness",
  "receding":              "receding",
  "residing hairline":     "receding hairline",

  // ── Common Hinglish mishearings ──────────────────────────────────
  "tritamen":         "treatment",
  "tritament":        "treatment",
  "tritment":         "treatment",
  "prosedure":        "procedure",
  "prosidure":        "procedure",
  "consultetion":     "consultation",
  "consultation":     "consultation",
  "nechrul luking":   "natural looking",
  "nechrul luk":      "natural look",
  "nechrul":          "natural",
  "nechral":          "natural",
  "luking":           "looking",
  "shootinguting":    "shooting",
  "shootingting":     "shooting",
  "katavane":         "kaatne",
  "katavana":         "kaatna",
  "lagara":           "lagra",
  "lekhi":            "lekin",
  "leki":             "lekin",
  "kunki":            "kyunki",
  "kyonki":           "kyunki",
  "hoyega":           "hoga",
  "bal":              "baal",

  // ── English words STT often hallucinates as phonetic Roman ───────
  "laiph":            "life",
  "phone":            "phone",
  "confidance":       "confidence",
  "koanphidentali":   "confidentially",
  "wai fai":          "WiFi",
  "waife":            "wife",

  // ── Titles / honorifics ──────────────────────────────────────────
  "dr":               "Dr.",
  "doktar":           "Doctor",
  "doaktar":          "Doctor",
  "sar":              "sir",
  "madem":            "madam",
};

/**
 * Merge the built-in clinic glossary with a user-supplied one.
 * User entries WIN when a key collides — the user has explicit intent,
 * defaults are heuristic.
 */
export function mergeWithClinicGlossary(
  userEntries: Record<string, string>
): Record<string, string> {
  return { ...CLINIC_GLOSSARY, ...userEntries };
}
