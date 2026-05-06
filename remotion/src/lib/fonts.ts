/**
 * Curated font catalogue — exported from the @captora/remotion workspace
 * so both the editor's TextPanel and the renderer use the same list.
 *
 * Strategy:
 *   - Pull 25 viral-friendly fonts from Google Fonts (free, CDN-hosted)
 *   - Single stylesheet URL covers them all → one network round-trip
 *   - Both web + Remotion bundle preload this URL; renders + previews see
 *     identical glyphs
 *
 * Adding a new font:
 *   1. Append a `FontDef` row below
 *   2. Append `family=<Name>:<weights>` to GOOGLE_FONTS_URL
 *   3. (no code change in TextPanel — dropdown reads from this list)
 */

export type FontCategory =
  | "display"      // bold headline / impact fonts — Bold Viral go-tos
  | "sans"         // clean modern sans-serifs
  | "elegant"      // serif / display serifs for premium look
  | "handwritten"  // script / handwritten / casual
  | "mono"         // monospace / tech vibe
  | "devanagari";  // supports Hindi / Marathi / Sanskrit script natively

export interface FontDef {
  /** The exact `font-family` value used in CSS. Quoted so spaces are OK. */
  family: string;
  /** Group label in the picker UI. */
  category: FontCategory;
  /** Optional fallback note shown under the option. */
  hint?: string;
}

export const FONTS: FontDef[] = [
  // Display / bold — the workhorses for viral captions
  { family: "Anton",            category: "display",     hint: "Compressed, bold — default for Bold Viral" },
  { family: "Bebas Neue",       category: "display",     hint: "Tall caps, classic social vibe" },
  { family: "Oswald",           category: "display",     hint: "Slightly narrower than Bebas, very readable" },
  { family: "Bowlby One",       category: "display",     hint: "Heavy, rounded — playful impact" },
  { family: "Black Ops One",    category: "display",     hint: "Stencil military feel" },
  { family: "Russo One",        category: "display",     hint: "Bold + slight italic, punchy" },
  { family: "Archivo Black",    category: "display",     hint: "Geometric heavy, modern" },

  // Sans-serif modern
  { family: "Inter",            category: "sans",        hint: "Default UI / body" },
  { family: "Poppins",          category: "sans",        hint: "Geometric, friendly — Instagram favourite" },
  { family: "Montserrat",       category: "sans",        hint: "Versatile sans" },
  { family: "Roboto",           category: "sans" },
  { family: "Open Sans",        category: "sans" },
  { family: "Nunito",           category: "sans",        hint: "Soft rounded corners" },
  { family: "Work Sans",        category: "sans" },

  // Elegant — for educational / premium content
  { family: "Playfair Display", category: "elegant",     hint: "High-contrast serif, magazine feel" },
  { family: "Bodoni Moda",      category: "elegant",     hint: "Fashion / editorial serif" },

  // Handwritten / script
  { family: "Caveat",           category: "handwritten", hint: "Casual handwriting" },
  { family: "Dancing Script",   category: "handwritten", hint: "Bouncy script" },
  { family: "Pacifico",         category: "handwritten", hint: "Surf / retro signature" },
  { family: "Satisfy",          category: "handwritten", hint: "Brush-script signature" },
  { family: "Kalam",            category: "handwritten", hint: "Handwritten + supports Devanagari" },

  // Monospace
  { family: "JetBrains Mono",   category: "mono",        hint: "Coder / tech feel" },
  { family: "Space Mono",       category: "mono",        hint: "Retro mono" },

  // Devanagari-friendly
  { family: "Tiro Devanagari Hindi", category: "devanagari", hint: "Designed for long-form Hindi" },
  { family: "Hind",             category: "devanagari",  hint: "Latin + Devanagari pair" },
  { family: "Mukta",            category: "devanagari",  hint: "Multi-script Indic + Latin" },
];

/**
 * Single Google Fonts CSS URL preloading every family above. Composed in
 * one request so the font CDN bundles weights efficiently. `display=swap`
 * keeps text visible while the file downloads instead of flashing
 * invisible.
 */
export const GOOGLE_FONTS_URL =
  "https://fonts.googleapis.com/css2?" +
  [
    "family=Anton",
    "family=Bebas+Neue",
    "family=Oswald:wght@400;500;600;700",
    "family=Bowlby+One",
    "family=Black+Ops+One",
    "family=Russo+One",
    "family=Archivo+Black",
    "family=Inter:wght@400;500;600;700;800;900",
    "family=Poppins:wght@400;500;600;700;800;900",
    "family=Montserrat:wght@400;500;600;700;800;900",
    "family=Roboto:wght@400;500;700;900",
    "family=Open+Sans:wght@400;500;600;700;800",
    "family=Nunito:wght@400;500;600;700;800;900",
    "family=Work+Sans:wght@400;500;600;700;800;900",
    "family=Playfair+Display:wght@400;600;700;800;900",
    "family=Bodoni+Moda:wght@400;500;600;700;800;900",
    "family=Caveat:wght@400;500;600;700",
    "family=Dancing+Script:wght@400;500;600;700",
    "family=Pacifico",
    "family=Satisfy",
    "family=Kalam:wght@300;400;700",
    "family=JetBrains+Mono:wght@400;500;600;700;800",
    "family=Space+Mono:wght@400;700",
    "family=Tiro+Devanagari+Hindi",
    "family=Hind:wght@300;400;500;600;700",
    "family=Mukta:wght@300;400;500;600;700;800",
  ].join("&") +
  "&display=swap";

/** Family name → CSS font-family value (quoted). */
export function fontStack(family: string): string {
  return `'${family}', sans-serif`;
}

export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  display: "Display / Bold",
  sans: "Sans-serif",
  elegant: "Elegant",
  handwritten: "Handwritten",
  mono: "Monospace",
  devanagari: "Hindi / Devanagari",
};
