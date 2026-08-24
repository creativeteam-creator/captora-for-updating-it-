/**
 * Caption style presets — web-side surface.
 *
 * The style data itself (`CaptionStyleId`, `CaptionStyle`, `CAPTION_STYLES`,
 * `rgbToCss`) now lives in `remotion/src/styles.ts` and is re-exported here
 * via `@captora/remotion`. It used to be a hand-copied duplicate of that
 * file — the two drifted (12 of 35 templates were missing their `isNew`
 * badge on one side) because every preset edit had to be applied twice and
 * nothing enforced that. See the comment at the top of the remotion file
 * for why the duplication existed and why it no longer needs to.
 *
 * What's still genuinely web-only, and stays in this file:
 *   - `CaptionStyleOverrides` — the shape of a Text-panel edit.
 *   - `DEFAULT_STYLE` — which preset a fresh project starts on.
 *   - `TemplateCategory` + `CATEGORY_*` — the Templates panel's filter
 *     grouping. The renderer has no concept of categories; it only reads
 *     the declarative style fields.
 *   - `applyStyleOverrides` — merges a preset with the panel's edits.
 *   - `hexToRgb` / `rgbToHex` — colour-picker conversions; `CaptionStyle`
 *     stores colour as `RGB` (0–1 floats) but `<input type="color">`
 *     speaks hex.
 */

export type {
  CaptionStyleId,
  RGB,
  CaptionStyle,
} from "@captora/remotion";
export { CAPTION_STYLES, rgbToCss } from "@captora/remotion";

import type { CaptionStyleId, RGB, CaptionStyle } from "@captora/remotion";

export type CaptionStyleOverrides = Partial<Omit<CaptionStyle, "id" | "label">>;

export const DEFAULT_STYLE: CaptionStyleId = "captora-glow";

/**
 * Template categories — surface groups in the Templates panel so users
 * can filter 35 templates without scrolling a single flat list. Ordered
 * roughly by prominence: newer kinetic styles first, then core groups
 * in decreasing frequency of use.
 */
export type TemplateCategory =
  | "kinetic"
  | "bold"
  | "neon"
  | "clean"
  | "boxed"
  | "effect";

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  kinetic: "Kinetic",
  bold: "Bold",
  neon: "Neon",
  clean: "Clean",
  boxed: "Boxed",
  effect: "Effect",
};

/**
 * Ordered list of categories for chip rows — this order drives the
 * left-to-right order in the TemplatesPanel filter bar.
 */
export const CATEGORY_ORDER: TemplateCategory[] = [
  "kinetic",
  "bold",
  "neon",
  "clean",
  "boxed",
  "effect",
];

/**
 * Category assignment for every CaptionStyleId. Grouped here (instead
 * of inline on each template) so a template's category can be adjusted
 * without opening the preset file, and so future auto-tests can
 * round-trip category → template counts.
 *
 * The `Record<CaptionStyleId, TemplateCategory>` annotation makes this
 * exhaustive: adding a template to `CAPTION_STYLES` (in the remotion
 * package) without adding a matching entry here is a type error, not a
 * template that silently vanishes from every category filter in the
 * Templates panel.
 */
export const TEMPLATE_CATEGORY: Record<CaptionStyleId, TemplateCategory> = {
  // ── Kinetic — motion-forward layouts, per-word entrance emphasis ────
  "kinetic-pop":            "kinetic",
  "bouncy-mix":             "kinetic",
  "slide-cascade":          "kinetic",
  "drop-stack":             "kinetic",
  "rotate-flair":           "kinetic",
  "cluster-kinetic":        "kinetic",
  "word-pile-stack":        "kinetic",
  "vertical-sticker-stack": "kinetic",

  // ── Bold — thick strokes, high-contrast, viral short-form ───────────
  "bold-viral":       "bold",
  "hormozi":          "bold",
  "mr-beast":         "bold",
  "top-up":           "bold",
  "splash":           "bold",
  "ziada":            "bold",
  "center-power":     "bold",

  // ── Neon — glow effects, luminous accent ────────────────────────────
  "neon-pill-bar":    "neon",
  "captora-glow":     "neon",
  "liquid-glass":     "neon",

  // ── Clean — minimal, editorial ──────────────────────────────────────
  "clean-medical":    "clean",
  "tech-minimal":     "clean",
  "ali-abdaal":       "clean",
  "tiktok-top":       "clean",
  "caption-bottom":   "clean",

  // ── Boxed — pill/chip backgrounds, sticker feel ─────────────────────
  "bubble-style":     "boxed",
  "editing-skool":    "boxed",
  "word-chips":       "boxed",
  "kalakar":          "boxed",
  "kalakar-shadow":   "boxed",
  "named-style":      "boxed",

  // ── Effect — special renders (blur reveals, pixel, highlight) ──────
  "blur-reveal":      "effect",
  "pixelated-word":   "effect",
  "highlight-word":   "effect",
  "captora":          "effect",
  "captora-shadow":   "effect",
};

/** Count of templates in each category — memoised at module load so
 *  the TemplatesPanel chip row can show "Kinetic (8)" style counts
 *  without recomputing on every render. */
export const CATEGORY_COUNTS: Record<TemplateCategory, number> = (() => {
  const out: Record<TemplateCategory, number> = {
    kinetic: 0, bold: 0, neon: 0, clean: 0, boxed: 0, effect: 0,
  };
  for (const cat of Object.values(TEMPLATE_CATEGORY)) out[cat]++;
  return out;
})();

export function applyStyleOverrides(
  base: CaptionStyle,
  overrides: CaptionStyleOverrides | undefined
): CaptionStyle {
  if (!overrides) return base;
  return { ...base, ...overrides };
}

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 0xff) / 255, (n >> 8 & 0xff) / 255, (n & 0xff) / 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}
