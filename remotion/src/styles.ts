/**
 * Mirror of `web/src/lib/styles.ts`. Kept duplicated rather than imported
 * across workspaces to avoid pulling Next.js / web-only deps into the
 * Remotion bundle. If you change presets, update both files.
 *
 * Visual variants are driven by *declarative* fields (textCase, glowOnActive,
 * boxBackground, highlightGradient) rather than `style.id` checks inside
 * the renderer — that way adding a new template is just a new entry here.
 */

export type CaptionStyleId =
  | "bold-viral"
  | "clean-medical"
  | "tech-minimal"
  | "captora-glow"
  | "captora-shadow"
  | "captora"
  | "ali-abdaal"
  | "tiktok-top"
  | "caption-bottom"
  | "center-power"
  | "word-chips"
  | "bouncy-mix"
  | "kinetic-pop"
  | "slide-cascade"
  | "blur-reveal"
  | "drop-stack"
  | "rotate-flair"
  // ── Kalakar-clone templates (Phase B) ────────────────────────
  | "hormozi"
  | "mr-beast"
  | "bubble-style";

export type RGB = [number, number, number];

export interface CaptionStyle {
  id: CaptionStyleId;
  label: string;
  baseColor: RGB;
  highlightColor: RGB;
  popInDurationSec: number;
  fontFamily: string;
  fontSize: number;
  strokeWidth: number;
  shadowOpacity: number;
  /** X position as a fraction of frame width (0 = left, 1 = right). */
  horizontalPosition?: number;
  /** Y position as a fraction of frame height (0 = top, 1 = bottom). */
  verticalPosition: number;
  /** Optional NEW badge for the template card. */
  isNew?: boolean;
  /**
   * How many seconds before the measured word timestamp to switch the
   * active-word highlight.  Compensates for Whisper’s acoustic detection
   * lag (~80–150 ms for Hindi / mixed-language content).
   *
   * Default when omitted: 0.10 (100 ms) — applied in PhraseCaption.
   * Set to 0 to disable anticipation entirely.
   * Expose in the TextPanel “Sync” slider so users can fine-tune per project.
   */
  wordAnticipationSec?: number;
  /** Visual case applied to all words. */
  textCase?: "upper" | "lower" | "sentence";
  /** Additional bold ON TOP of the font's natural weight. Useful for
   *  fonts like Inter/Montserrat with light defaults. */
  bold?: boolean;
  /** Italic / oblique style. */
  italic?: boolean;
  /** Underline decoration on every word. */
  underline?: boolean;
  /** Line-height multiplier for wrapped phrases. 1.0 = font default. */
  lineHeight?: number;
  /** Letter-spacing in pixels. Negative tightens, positive widens. */
  letterSpacing?: number;
  /** Paragraph alignment when phrase wraps to multiple lines. */
  textAlign?: "left" | "center" | "right";
  /** Custom drop-shadow tuning (replaces the implicit 0/4/12px-black). */
  dropShadowColor?: RGB;
  dropShadowBlur?: number;
  dropShadowOffsetX?: number;
  dropShadowOffsetY?: number;
  /**
   * Outer-glow mode (replaces the older `glowOnActive` boolean):
   *   "none" / "active" / "all"
   * `glowOnActive: true` is treated as "active".
   */
  glowMode?: "none" | "active" | "all";
  /** Glow halo color. Defaults to highlightColor. */
  glowColor?: RGB;
  /** Glow blur radius in pixels. Default 24. */
  glowBlur?: number;
  /** When true, the active word gets a coloured halo glow (textShadow). */
  glowOnActive?: boolean;
  /** Two-tone gradient on the active word — top → bottom of the glyph. */
  highlightGradient?: { from: RGB; to: RGB };
  /** Wrap the whole phrase in a rounded coloured pill (Submagic / Ali Abdaal look). */
  boxBackground?: { color: RGB; paddingX: number; paddingY: number; radius: number };
  /**
   * Inactive-word colour for the boxed look (typically a dim grey so the
   * active word reads as the focus). Falls back to baseColor when absent.
   */
  boxInactiveColor?: RGB;
  /**
   * Wrap each WORD individually in a coloured pill (vs `boxBackground`
   * which wraps the whole phrase). Active word's chip uses
   * `highlightColor`; inactive chips use `boxInactiveColor` (or a soft
   * dim of `baseColor`).
   */
  perWordChip?: { paddingX: number; paddingY: number; radius: number };
  /**
   * When true (used with `perWordChip`), ONLY the active word gets the
   * coloured chip background — inactive words render as plain text in
   * `baseColor`. Drives the "Bubble Style" Kalakar look: clean white
   * line of words with a single green pill around the spoken word.
   */
  perWordChipActiveOnly?: boolean;
  /**
   * Per-word entrance animation. Drives the way each word "lands" on
   * screen at its own `word.start` time — independent of the phrase
   * entrance variant. Two shapes:
   *   - Single variant — every word in the phrase gets the same entrance
   *     (still timed to its own start), e.g. "slide-up" makes each
   *     word slide up from below as it's spoken.
   *   - Array — variants cycle by word index within the phrase, so
   *     consecutive words land with different animations (kinetic
   *     typography feel).
   * `"none"` (or omitted) preserves the legacy behaviour where the
   * whole phrase appears together with the phrase entrance.
   */
  wordEntrance?:
    | "none"
    | "pop"
    | "slide-up"
    | "slide-down"
    | "scale"
    | "blur"
    | "rotate"
    | "bounce"
    | "drop"
    | Array<
        | "none"
        | "pop"
        | "slide-up"
        | "slide-down"
        | "scale"
        | "blur"
        | "rotate"
        | "bounce"
        | "drop"
      >;
  /** How long each per-word entrance lasts (seconds). Defaults to 0.18s. */
  wordEntranceDurationSec?: number;
  /**
   * How wrapped rows of a single phrase align horizontally:
   *   - undefined / "center" → all rows centered (legacy default).
   *   - "stagger" → first row left, middle row(s) centered, last row
   *     right. Splits the phrase by character count into 3 rows so a
   *     short phrase like "Hello and welcome to Captora" lands with
   *     intentional visual asymmetry. Phrases of 1-2 words stay
   *     single-row centered (nothing to stagger).
   */
  rowAlignment?: "center" | "stagger";
  /**
   * Cycle vertical position per phrase. Phrase 0 → cycle[0], phrase 1 →
   * cycle[1], etc., wrapping. Gives a "captions appear at various places"
   * feel without rebuilding the layout. Falls back to `verticalPosition`
   * when absent.
   */
  verticalPositionCycle?: number[];
}

export const CAPTION_STYLES: Record<CaptionStyleId, CaptionStyle> = {
  "bold-viral": {
    id: "bold-viral",
    label: "Bold Viral",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.92, 0.0],
    popInDurationSec: 0.10,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 96,
    strokeWidth: 8,
    shadowOpacity: 0.75,
    verticalPosition: 0.6,
    textCase: "upper",
  },
  "clean-medical": {
    id: "clean-medical",
    label: "Clean Medical",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.78, 0.30],
    popInDurationSec: 0.20,
    fontFamily: "Inter, Helvetica Neue, sans-serif",
    fontSize: 64,
    strokeWidth: 1,
    shadowOpacity: 0.30,
    verticalPosition: 0.8,
    textCase: "sentence",
  },
  "tech-minimal": {
    id: "tech-minimal",
    label: "Tech Minimal",
    baseColor: [1, 1, 1],
    highlightColor: [0.20, 0.85, 1.0],
    popInDurationSec: 0.14,
    fontFamily: "Inter, SF Pro Text, sans-serif",
    fontSize: 72,
    strokeWidth: 2,
    shadowOpacity: 0.45,
    verticalPosition: 0.7,
    textCase: "sentence",
    glowOnActive: true,
  },
  "captora-glow": {
    id: "captora-glow",
    label: "Captora Glow",
    baseColor: [1, 1, 1],
    // Captora's signature emerald-green
    highlightColor: [0.43, 0.85, 0.30],
    popInDurationSec: 0.14,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 84,
    strokeWidth: 4,
    shadowOpacity: 0.6,
    verticalPosition: 0.7,
    textCase: "upper",
    glowOnActive: true,
  },
  "captora-shadow": {
    id: "captora-shadow",
    label: "Captora Shadow",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.55, 0.0],
    popInDurationSec: 0.14,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 84,
    strokeWidth: 4,
    shadowOpacity: 0.85,
    verticalPosition: 0.7,
    textCase: "upper",
    highlightGradient: { from: [1.0, 0.78, 0.0], to: [0.85, 0.30, 0.0] },
  },
  captora: {
    id: "captora",
    label: "Captora",
    baseColor: [1, 1, 1],
    highlightColor: [0.43, 0.85, 0.30],
    popInDurationSec: 0.12,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 84,
    strokeWidth: 6,
    shadowOpacity: 0.5,
    verticalPosition: 0.7,
    textCase: "upper",
  },
  "ali-abdaal": {
    id: "ali-abdaal",
    label: "Ali Abdaal",
    // Dark text on a white pill — base = dim grey, highlight = pure black.
    baseColor: [0.0, 0.0, 0.0],
    highlightColor: [0.0, 0.0, 0.0],
    popInDurationSec: 0.18,
    fontFamily: "Inter, SF Pro Text, sans-serif",
    fontSize: 60,
    strokeWidth: 0,
    shadowOpacity: 0.15,
    verticalPosition: 0.78,
    textCase: "sentence",
    boxBackground: { color: [1, 1, 1], paddingX: 36, paddingY: 18, radius: 16 },
    boxInactiveColor: [0.55, 0.55, 0.55],
  },
  "tiktok-top": {
    id: "tiktok-top",
    label: "TikTok Top",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.95, 0.0],
    popInDurationSec: 0.10,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 92,
    strokeWidth: 7,
    shadowOpacity: 0.7,
    verticalPosition: 0.15,
    textCase: "upper",
  },
  "caption-bottom": {
    id: "caption-bottom",
    label: "Caption Bottom",
    baseColor: [1, 1, 1],
    highlightColor: [1, 1, 1],
    popInDurationSec: 0.18,
    fontFamily: "Inter, Helvetica Neue, sans-serif",
    fontSize: 56,
    strokeWidth: 0,
    shadowOpacity: 0.85,
    verticalPosition: 0.92,
    textCase: "sentence",
  },
  "center-power": {
    id: "center-power",
    label: "Center Power",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.20, 0.55],
    popInDurationSec: 0.12,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 110,
    strokeWidth: 10,
    shadowOpacity: 0.9,
    verticalPosition: 0.5,
    textCase: "upper",
  },
  "word-chips": {
    id: "word-chips",
    label: "Word Chips",
    baseColor: [0.95, 0.95, 0.95],
    highlightColor: [0.43, 0.85, 0.30],
    popInDurationSec: 0.14,
    fontFamily: "Inter, SF Pro Text, sans-serif",
    fontSize: 56,
    strokeWidth: 0,
    shadowOpacity: 0.4,
    verticalPosition: 0.75,
    textCase: "sentence",
    perWordChip: { paddingX: 18, paddingY: 8, radius: 10 },
    boxInactiveColor: [0.18, 0.20, 0.25],
  },
  "bouncy-mix": {
    id: "bouncy-mix",
    label: "Bouncy Mix",
    baseColor: [1, 1, 1],
    highlightColor: [0.20, 0.85, 1.0],
    popInDurationSec: 0.12,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 88,
    strokeWidth: 6,
    shadowOpacity: 0.65,
    verticalPosition: 0.5,
    textCase: "upper",
    glowOnActive: true,
    // Each phrase lands at a different Y — top, lower-mid, bottom, upper-mid.
    verticalPositionCycle: [0.18, 0.55, 0.85, 0.40],
  },
  // ─── Per-word entrance templates (kinetic typography) ─────────────────
  // Mirror of web/src/lib/styles.ts. The renderer reads `wordEntrance` and
  // applies a per-word animation timed to each word's own start, instead
  // of the whole phrase popping in at once.
  "kinetic-pop": {
    id: "kinetic-pop",
    label: "Kinetic Pop",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.92, 0.0],
    popInDurationSec: 0.10,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 96,
    strokeWidth: 8,
    shadowOpacity: 0.75,
    verticalPosition: 0.55,
    textCase: "upper",
    wordEntrance: "pop",
    wordEntranceDurationSec: 0.16,
    rowAlignment: "stagger",
  },
  "slide-cascade": {
    id: "slide-cascade",
    label: "Slide Cascade",
    baseColor: [1, 1, 1],
    highlightColor: [0.43, 0.85, 0.30],
    popInDurationSec: 0.10,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 88,
    strokeWidth: 6,
    shadowOpacity: 0.6,
    verticalPosition: 0.62,
    textCase: "upper",
    glowOnActive: true,
    wordEntrance: ["slide-up", "slide-down", "scale", "slide-up"],
    wordEntranceDurationSec: 0.20,
    rowAlignment: "stagger",
  },
  "blur-reveal": {
    id: "blur-reveal",
    label: "Blur Reveal",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.95, 0.85],
    popInDurationSec: 0.18,
    fontFamily: "Playfair Display, Georgia, serif",
    fontSize: 72,
    strokeWidth: 0,
    shadowOpacity: 0.55,
    verticalPosition: 0.7,
    textCase: "sentence",
    wordEntrance: "blur",
    wordEntranceDurationSec: 0.28,
  },
  "drop-stack": {
    id: "drop-stack",
    label: "Drop Stack",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.20, 0.55],
    popInDurationSec: 0.12,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 100,
    strokeWidth: 9,
    shadowOpacity: 0.85,
    verticalPosition: 0.5,
    textCase: "upper",
    wordEntrance: ["drop", "bounce", "drop", "pop"],
    wordEntranceDurationSec: 0.22,
    rowAlignment: "stagger",
  },
  "rotate-flair": {
    id: "rotate-flair",
    label: "Rotate Flair",
    baseColor: [0.95, 0.95, 0.95],
    highlightColor: [0.43, 0.85, 0.30],
    popInDurationSec: 0.14,
    fontFamily: "Inter, SF Pro Text, sans-serif",
    fontSize: 60,
    strokeWidth: 0,
    shadowOpacity: 0.4,
    verticalPosition: 0.7,
    textCase: "sentence",
    perWordChip: { paddingX: 18, paddingY: 8, radius: 10 },
    boxInactiveColor: [0.18, 0.20, 0.25],
    wordEntrance: ["rotate", "pop", "scale", "rotate"],
    wordEntranceDurationSec: 0.20,
    rowAlignment: "stagger",
  },
  // ─── Kalakar-clone templates (Phase B) ─────────────────────────────────
  // Modelled directly on the user-supplied Kalakar editor screenshots so
  // each new template is a 1:1 visual + motion match for what Kalakar
  // ships under the same name. Iter 1 = Hormozi.
  hormozi: {
    id: "hormozi",
    label: "Hormozi",
    isNew: true,
    // White base, sharp lime-yellow active word — the canonical Alex
    // Hormozi short-form caption look. Big heavy condensed font with a
    // strong matching glow on the active token so single words read at
    // a glance even on a phone scrubbing through Reels.
    baseColor: [1, 1, 1],
    highlightColor: [0.80, 1.0, 0.05], // ~#CBFF0D
    popInDurationSec: 0.10,
    fontFamily: "Anton, Bebas Neue, Druk, Montserrat, Inter, sans-serif",
    fontSize: 110,
    strokeWidth: 6,
    shadowOpacity: 0.55,
    verticalPosition: 0.62,
    textCase: "upper",
    bold: true,
    letterSpacing: 1,
    lineHeight: 0.95,
    glowMode: "active",
    glowColor: [0.80, 1.0, 0.05],
    glowBlur: 36,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 18,
    dropShadowOffsetX: 0,
    dropShadowOffsetY: 6,
    wordEntrance: "pop",
    wordEntranceDurationSec: 0.16,
  },
  "mr-beast": {
    id: "mr-beast",
    label: "Mr Beast Style",
    isNew: true,
    // White caps with a THICK black stroke + sharp drop shadow — the
    // signature MrBeast / classic YouTube Shorts caption that pops
    // against any background. Active word flips to bright yellow
    // without losing the outline. No glow (would soften the look) —
    // the contrast is the whole point.
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.95, 0.0], // bright yellow
    popInDurationSec: 0.10,
    fontFamily: "Anton, Bebas Neue, Impact, Montserrat, Inter, sans-serif",
    fontSize: 104,
    // 12px stroke is the signature — most templates use 4-8, MrBeast
    // is intentionally heavier so the text reads as sticker-style.
    strokeWidth: 12,
    shadowOpacity: 0.95,
    verticalPosition: 0.62,
    textCase: "upper",
    bold: true,
    letterSpacing: 1,
    lineHeight: 1.0,
    // Sharp, offset drop shadow (no blur) reinforces the sticker feel.
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 0,
    dropShadowOffsetX: 6,
    dropShadowOffsetY: 8,
    glowMode: "none",
    wordEntrance: "pop",
    wordEntranceDurationSec: 0.16,
  },
  "bubble-style": {
    id: "bubble-style",
    label: "Bubble Style",
    isNew: true,
    // Clean white serif/sans line of words with a SINGLE green pill
    // around just the spoken word. The bubble travels left-to-right
    // as playback advances — the rest of the phrase stays plain text.
    // Modelled on Kalakar's "Bubble Style" template card preview:
    // `The quick [brown] fox` with `brown` in a green pill.
    baseColor: [1, 1, 1],
    // Bright Kalakar-style green (≈ #22D15E) — same as the screenshot.
    highlightColor: [0.13, 0.82, 0.37],
    popInDurationSec: 0.14,
    // Serif default like the Kalakar preview ("The quick brown fox")
    // — distinguishes Bubble from the other heavy-sans templates.
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 72,
    strokeWidth: 0,
    shadowOpacity: 0.35,
    verticalPosition: 0.7,
    textCase: "sentence",
    bold: true,
    letterSpacing: 0,
    lineHeight: 1.15,
    // The defining trait: chip on every word's slot, but the new
    // perWordChipActiveOnly flag suppresses the inactive chips so we
    // see exactly one green pill following the spoken word.
    perWordChip: { paddingX: 18, paddingY: 8, radius: 10 },
    perWordChipActiveOnly: true,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 12,
    dropShadowOffsetX: 0,
    dropShadowOffsetY: 4,
    glowMode: "none",
  },
};

export function rgbToCss([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}
