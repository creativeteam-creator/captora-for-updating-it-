/**
 * Caption style presets — single source of truth for the web app.
 *
 * Mirrors `remotion/src/styles.ts`. Kept duplicated rather than imported
 * across workspaces to avoid pulling Remotion into the web bundle for every
 * UI render. Both files MUST stay in sync — declarative variants
 * (textCase, glowOnActive, boxBackground, highlightGradient) drive the
 * renderer; the web side uses them to build accurate template-card previews.
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
  // ── Kalakar-clone templates (Phase B) ─────────────────────────
  | "hormozi"
  | "mr-beast"
  | "bubble-style"
  | "editing-skool"
  | "liquid-glass"
  | "pixelated-word"
  | "ziada"
  | "top-up"
  | "splash"
  | "highlight-word"
  | "kalakar"
  | "kalakar-shadow"
  | "named-style"
  | "cluster-kinetic";

export type RGB = [number, number, number];

export interface CaptionStyle {
  id: CaptionStyleId;
  label: string;
  description: string;
  baseColor: RGB;
  highlightColor: RGB;
  popInDurationSec: number;
  fontFamily: string;
  fontSize: number;
  strokeWidth: number;
  shadowOpacity: number;
  /** X position as a fraction of frame width (0 = left, 1 = right). */
  horizontalPosition?: number;
  verticalPosition: number;
  textCase?: "upper" | "lower" | "sentence";
  /** Additional bold weight ON TOP of the font's natural weight.
   *  Useful for fonts like Inter/Montserrat that have light defaults. */
  bold?: boolean;
  /** Italic / oblique style. */
  italic?: boolean;
  /** Underline decoration on every word. */
  underline?: boolean;
  /** Line-height multiplier for wrapped phrases. 1.0 = font default,
   *  1.2 = 20% extra leading, etc. Range 0.8–2.0. */
  lineHeight?: number;
  /** Letter-spacing in pixels. Negative = tighter, positive = wider.
   *  Common range: −2 to 8. */
  letterSpacing?: number;
  /** Paragraph alignment when phrase wraps to multiple lines. */
  textAlign?: "left" | "center" | "right";
  /**
   * Drop-shadow tuning. `shadowOpacity` already controls the legacy preset
   * (offset 0/4, blur 12, black). When any of these explicit fields is set
   * the renderer uses them directly. Color falls back to black; blur to
   * 12px; offsets to 0/4.
   */
  dropShadowColor?: RGB;
  dropShadowBlur?: number;
  dropShadowOffsetX?: number;
  dropShadowOffsetY?: number;
  /**
   * Outer-glow mode replaces the older `glowOnActive` boolean.
   *   "none"        – no glow
   *   "active"      – glow only on the currently spoken word (default look)
   *   "all"         – every word in the phrase glows continuously
   * `glowOnActive: true` from older presets is treated as "active".
   */
  glowMode?: "none" | "active" | "all";
  /** Glow halo color. Defaults to the active word's highlightColor. */
  glowColor?: RGB;
  /** Glow blur radius in pixels. Default 24 (matches existing renderer). */
  glowBlur?: number;
  glowOnActive?: boolean;
  highlightGradient?: { from: RGB; to: RGB };
  boxBackground?: {
    color: RGB;
    paddingX: number;
    paddingY: number;
    radius: number;
    opacity?: number;
    backdropBlur?: number;
  };
  boxInactiveColor?: RGB;
  /** Wrap each WORD individually in a coloured pill (vs `boxBackground`
   *  which wraps the whole phrase). */
  perWordChip?: { paddingX: number; paddingY: number; radius: number };
  /** When true (used with `perWordChip`), only the active word gets the
   *  chip background; inactive words render as plain baseColor text. */
  perWordChipActiveOnly?: boolean;
  /** When true, only the active word is rendered (single-word focus
   *  mode — Editing Skool style). */
  activeWordOnly?: boolean;
  /** Active-word size multiplier — drives the Splash template where
   *  the spoken word renders at ~1.85× the neighbours. */
  activeWordSizeMultiplier?: number;
  /** Emphasis mode for the active word:
   *  - "emphasize" (default): active brightens / scales up
   *  - "spotlight": inactive words dim instead */
  emphasisMode?: "emphasize" | "spotlight";
  /** Dim ratio (0..1) for inactive words under emphasisMode === "spotlight". */
  spotlightInactiveOpacity?: number;
  /** Cycle vertical position per phrase index — phrase 0 → cycle[0], etc.
   *  Falls back to `verticalPosition` when absent. */
  verticalPositionCycle?: number[];
  /**
   * Per-word entrance animation. Single variant applies to every word
   * in the phrase (each timed to its own start). Array cycles variants
   * by word index so consecutive words animate differently — that's
   * the "kinetic typography" effect the new templates use.
   */
  wordEntrance?: WordEntrance | WordEntrance[];
  /** Per-word entrance duration in seconds. Defaults to 0.18s. */
  wordEntranceDurationSec?: number;
  /**
   * How wrapped rows of a phrase align: "center" (default) or "stagger"
   * (top-row left, middle centered, bottom-row right). The renderer
   * splits the phrase by character count into 3 rows so a short phrase
   * lands with intentional visual asymmetry.
   */
  rowAlignment?: "center" | "stagger";
  /** Optional NEW badge for the template card. */
  isNew?: boolean;
  /**
   * How many seconds before the measured word timestamp to switch the
   * active-word highlight. Compensates for Whisper's acoustic detection
   * lag (~80–150 ms for Hindi / mixed-language content).
   *
   * Default when omitted: 0.10 (100 ms) — applied in PhraseCaption.
   * Set to 0 to disable. Exposed via the TextPanel "Sync" slider.
   */
  wordAnticipationSec?: number;
  /**
   * Kinetic-typography cluster mode — words scatter around the phrase
   * center with one "hero" word (longest content word) rendered at
   * `heroScale`. Drives the CapCut / Instagram-Reels viral caption
   * look. When set, the renderer bypasses PhraseCaption's row layout
   * and uses ClusterCaption instead. Absent by default.
   */
  cluster?: {
    heroScale?: number;
    scatterRadius?: number;
    maxRotationDeg?: number;
    heroColor?: RGB;
  };
}

/** Mirror of `WordEntranceVariant` in remotion/src/lib/entranceVariants.ts. */
export type WordEntrance =
  | "none"
  | "pop"
  | "slide-up"
  | "slide-down"
  | "scale"
  | "blur"
  | "rotate"
  | "bounce"
  | "drop";

export type CaptionStyleOverrides = Partial<Omit<CaptionStyle, "id" | "label" | "description">>;

export const CAPTION_STYLES: Record<CaptionStyleId, CaptionStyle> = {
  "bold-viral": {
    id: "bold-viral",
    label: "Bold Viral",
    description: "Yellow highlight · snappy pop-in",
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
    description: "Amber highlight · gentle pop-in",
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
    description: "Cyan glow on active word",
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
    description: "Emerald glow · bold uppercase",
    baseColor: [1, 1, 1],
    highlightColor: [0.43, 0.85, 0.30],
    popInDurationSec: 0.14,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 84,
    strokeWidth: 4,
    shadowOpacity: 0.6,
    verticalPosition: 0.7,
    textCase: "upper",
    glowOnActive: true,
    isNew: true,
  },
  "captora-shadow": {
    id: "captora-shadow",
    label: "Captora Shadow",
    description: "Orange gradient · deep shadow",
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
    isNew: true,
  },
  captora: {
    id: "captora",
    label: "Captora",
    description: "Emerald · clean stroke · uppercase",
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
    description: "White pill · minimal subtitles",
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
    description: "Top of frame · yellow uppercase",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.95, 0.0],
    popInDurationSec: 0.10,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 92,
    strokeWidth: 7,
    shadowOpacity: 0.7,
    verticalPosition: 0.15,
    textCase: "upper",
    isNew: true,
  },
  "caption-bottom": {
    id: "caption-bottom",
    label: "Caption Bottom",
    description: "Traditional movie subtitle · clean white",
    baseColor: [1, 1, 1],
    highlightColor: [1, 1, 1],
    popInDurationSec: 0.18,
    fontFamily: "Inter, Helvetica Neue, sans-serif",
    fontSize: 56,
    strokeWidth: 0,
    shadowOpacity: 0.85,
    verticalPosition: 0.92,
    textCase: "sentence",
    isNew: true,
  },
  "center-power": {
    id: "center-power",
    label: "Center Power",
    description: "Middle of frame · huge magenta",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.20, 0.55],
    popInDurationSec: 0.12,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 110,
    strokeWidth: 10,
    shadowOpacity: 0.9,
    verticalPosition: 0.5,
    textCase: "upper",
    isNew: true,
  },
  "word-chips": {
    id: "word-chips",
    label: "Word Chips",
    description: "Each word in its own coloured pill",
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
    isNew: true,
  },
  "bouncy-mix": {
    id: "bouncy-mix",
    label: "Bouncy Mix",
    description: "Captions appear at various heights · cyan glow",
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
    verticalPositionCycle: [0.18, 0.55, 0.85, 0.40],
    isNew: true,
  },
  // ─── Per-word entrance templates (kinetic typography) ────────────────
  "kinetic-pop": {
    id: "kinetic-pop",
    label: "Kinetic Pop",
    description: "Each word springs in · staggered rows · bold uppercase",
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
    isNew: true,
  },
  "slide-cascade": {
    id: "slide-cascade",
    label: "Slide Cascade",
    description: "Words slide alternately · staggered left-center-right rows",
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
    // Cycle alternating directions so consecutive words land from
    // opposite sides — the "different animation per word" feel.
    wordEntrance: ["slide-up", "slide-down", "scale", "slide-up"],
    wordEntranceDurationSec: 0.20,
    rowAlignment: "stagger",
    isNew: true,
  },
  "blur-reveal": {
    id: "blur-reveal",
    label: "Blur Reveal",
    description: "Soft blur-to-focus on each word · clean serif",
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
    isNew: true,
  },
  "drop-stack": {
    id: "drop-stack",
    label: "Drop Stack",
    description: "Words drop in · staggered rows · TikTok-style impact",
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.20, 0.55],
    popInDurationSec: 0.12,
    fontFamily: "Anton, Montserrat, Inter, sans-serif",
    fontSize: 100,
    strokeWidth: 9,
    shadowOpacity: 0.85,
    verticalPosition: 0.5,
    textCase: "upper",
    // Cycle: drop, then drop with bounce overshoot, then a pop variant —
    // gives a percussive "thud" rhythm word by word.
    wordEntrance: ["drop", "bounce", "drop", "pop"],
    wordEntranceDurationSec: 0.22,
    rowAlignment: "stagger",
    isNew: true,
  },
  "rotate-flair": {
    id: "rotate-flair",
    label: "Rotate Flair",
    description: "Tilting words · staggered rows · playful chip layout",
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
    isNew: true,
  },
  // ─── Kalakar-clone templates (Phase B) ───────────────────────────────
  // Mirrors of the remotion-side entries in remotion/src/styles.ts so the
  // editor's TemplatesPanel shows the cards. Both files must stay in
  // sync — the panel iterates THIS file's CAPTION_STYLES; the renderer
  // reads remotion's copy. Visual props are identical between them.
  hormozi: {
    id: "hormozi",
    label: "Hormozi",
    description: "Lime-yellow caps · heavy glow · viral short-form",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [0.80, 1.0, 0.05],
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
    description: "White caps · thick black stroke · sticker drop shadow",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.95, 0.0],
    popInDurationSec: 0.10,
    fontFamily: "Anton, Bebas Neue, Impact, Montserrat, Inter, sans-serif",
    fontSize: 104,
    strokeWidth: 12,
    shadowOpacity: 0.95,
    verticalPosition: 0.62,
    textCase: "upper",
    bold: true,
    letterSpacing: 1,
    lineHeight: 1.0,
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
    description: "White serif · single green pill traveling word-to-word",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [0.13, 0.82, 0.37],
    popInDurationSec: 0.14,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: 72,
    strokeWidth: 0,
    shadowOpacity: 0.35,
    verticalPosition: 0.7,
    textCase: "sentence",
    bold: true,
    letterSpacing: 0,
    lineHeight: 1.15,
    perWordChip: { paddingX: 18, paddingY: 8, radius: 10 },
    perWordChipActiveOnly: true,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 12,
    dropShadowOffsetX: 0,
    dropShadowOffsetY: 4,
    glowMode: "none",
  },
  "editing-skool": {
    id: "editing-skool",
    label: "Editing Skool",
    description: "Single-word focus · orange sticker chip",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [0.96, 0.54, 0.12],
    popInDurationSec: 0.10,
    fontFamily: "Inter, 'SF Pro Text', Montserrat, sans-serif",
    fontSize: 80,
    strokeWidth: 0,
    shadowOpacity: 0.50,
    verticalPosition: 0.78,
    textCase: "sentence",
    bold: true,
    letterSpacing: 0,
    lineHeight: 1.0,
    activeWordOnly: true,
    perWordChip: { paddingX: 22, paddingY: 10, radius: 12 },
    perWordChipActiveOnly: true,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 16,
    dropShadowOffsetX: 0,
    dropShadowOffsetY: 6,
    glowMode: "none",
    wordEntrance: "pop",
    wordEntranceDurationSec: 0.18,
  },
  "liquid-glass": {
    id: "liquid-glass",
    label: "Liquid Glass",
    description: "Frosted translucent pill · iOS glassmorphism",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [1, 1, 1],
    popInDurationSec: 0.14,
    fontFamily: "Inter, 'SF Pro Text', sans-serif",
    fontSize: 60,
    strokeWidth: 0,
    shadowOpacity: 0.25,
    verticalPosition: 0.72,
    textCase: "sentence",
    bold: false,
    boxBackground: {
      color: [1, 1, 1],
      paddingX: 32,
      paddingY: 14,
      radius: 999,
      opacity: 0.18,
      backdropBlur: 24,
    },
    boxInactiveColor: [0.7, 0.7, 0.75],
    glowMode: "none",
  },
  "pixelated-word": {
    id: "pixelated-word",
    label: "Pixelated Word",
    description: "8-bit retro pixel font · all caps",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.95, 0.0],
    popInDurationSec: 0.06,
    fontFamily: "'Press Start 2P', 'VT323', 'Silkscreen', 'Courier New', monospace",
    fontSize: 64,
    strokeWidth: 4,
    shadowOpacity: 0.4,
    verticalPosition: 0.72,
    textCase: "upper",
    bold: false,
    letterSpacing: 2,
    lineHeight: 1.0,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 0,
    dropShadowOffsetX: 4,
    dropShadowOffsetY: 4,
    glowMode: "none",
  },
  ziada: {
    id: "ziada",
    label: "Ziada",
    description: "White-in-black pill · stacked two-line layout",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [1, 1, 1],
    popInDurationSec: 0.16,
    fontFamily: "Inter, 'SF Pro Text', sans-serif",
    fontSize: 58,
    strokeWidth: 0,
    shadowOpacity: 0.55,
    verticalPosition: 0.78,
    textCase: "sentence",
    bold: true,
    letterSpacing: 0,
    lineHeight: 1.25,
    boxBackground: {
      color: [0.05, 0.05, 0.08],
      paddingX: 28,
      paddingY: 12,
      radius: 999,
      opacity: 0.95,
    },
    boxInactiveColor: [0.65, 0.65, 0.7],
    glowMode: "none",
  },
  "top-up": {
    id: "top-up",
    label: "Top Up",
    description: "Amber-gold active on white · upper-center placement",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.72, 0.0],
    popInDurationSec: 0.14,
    fontFamily: "Inter, 'SF Pro Text', Helvetica, sans-serif",
    fontSize: 70,
    strokeWidth: 0,
    shadowOpacity: 0.4,
    verticalPosition: 0.5,
    textCase: "sentence",
    bold: true,
    letterSpacing: 0,
    lineHeight: 1.15,
    glowMode: "active",
    glowColor: [1.0, 0.72, 0.0],
    glowBlur: 18,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 16,
    dropShadowOffsetX: 0,
    dropShadowOffsetY: 4,
  },
  splash: {
    id: "splash",
    label: "Splash",
    description: "Active word at 1.85× scale · vivid yellow-lime glow",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [0.97, 0.93, 0.18],
    popInDurationSec: 0.12,
    fontFamily: "Anton, Bebas Neue, Montserrat, Inter, sans-serif",
    fontSize: 64,
    strokeWidth: 2,
    shadowOpacity: 0.5,
    verticalPosition: 0.7,
    textCase: "upper",
    bold: true,
    letterSpacing: 1,
    lineHeight: 0.95,
    activeWordSizeMultiplier: 1.85,
    glowMode: "active",
    glowColor: [0.97, 0.93, 0.18],
    glowBlur: 28,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 12,
    dropShadowOffsetX: 0,
    dropShadowOffsetY: 4,
    wordEntrance: "pop",
    wordEntranceDurationSec: 0.18,
  },
  "highlight-word": {
    id: "highlight-word",
    label: "Highlight Word",
    description: "Minimal · white inactive · yellow active · no box",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.95, 0.0],
    popInDurationSec: 0.10,
    fontFamily: "Inter, 'SF Pro Text', sans-serif",
    fontSize: 68,
    strokeWidth: 0,
    shadowOpacity: 0.45,
    verticalPosition: 0.72,
    textCase: "sentence",
    bold: true,
    letterSpacing: 0,
    lineHeight: 1.1,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 14,
    dropShadowOffsetX: 0,
    dropShadowOffsetY: 4,
    glowMode: "none",
  },
  kalakar: {
    id: "kalakar",
    label: "Kalakar",
    description: "Signature yellow · big condensed · soft glow",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [1.0, 0.92, 0.08],
    popInDurationSec: 0.12,
    fontFamily: "Anton, Bebas Neue, Montserrat, Inter, sans-serif",
    fontSize: 96,
    strokeWidth: 4,
    shadowOpacity: 0.6,
    verticalPosition: 0.65,
    textCase: "upper",
    bold: true,
    letterSpacing: 1,
    lineHeight: 1.0,
    glowMode: "active",
    glowColor: [1.0, 0.92, 0.08],
    glowBlur: 28,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 16,
    dropShadowOffsetX: 0,
    dropShadowOffsetY: 6,
  },
  "kalakar-shadow": {
    id: "kalakar-shadow",
    label: "Kalakar Shadow",
    description: "Red caps · sharp 3D drop shadow · no blur",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [0.95, 0.12, 0.12],
    popInDurationSec: 0.12,
    fontFamily: "Anton, Bebas Neue, Impact, Montserrat, Inter, sans-serif",
    fontSize: 100,
    strokeWidth: 2,
    shadowOpacity: 1.0,
    verticalPosition: 0.65,
    textCase: "upper",
    bold: true,
    letterSpacing: 1,
    lineHeight: 1.0,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 0,
    dropShadowOffsetX: 8,
    dropShadowOffsetY: 10,
    glowMode: "none",
  },
  "named-style": {
    id: "named-style",
    label: "Named Style",
    description: "Bold caps · wide 8px letter spacing · magazine headline",
    isNew: true,
    baseColor: [1, 1, 1],
    highlightColor: [0.85, 0.85, 0.85],
    popInDurationSec: 0.18,
    fontFamily: "Inter, 'SF Pro Display', Helvetica, sans-serif",
    fontSize: 56,
    strokeWidth: 0,
    shadowOpacity: 0.35,
    verticalPosition: 0.72,
    textCase: "upper",
    bold: true,
    letterSpacing: 8,
    lineHeight: 1.1,
    dropShadowColor: [0, 0, 0],
    dropShadowBlur: 10,
    dropShadowOffsetX: 0,
    dropShadowOffsetY: 3,
    glowMode: "none",
  },
  "cluster-kinetic": {
    id: "cluster-kinetic",
    label: "Cluster Kinetic",
    description: "Kinetic mosaic · hero word centered · scattered surround",
    isNew: true,
    baseColor: [0.05, 0.05, 0.05],
    highlightColor: [0.13, 0.85, 0.29],
    popInDurationSec: 0.15,
    fontFamily: "Anton, Bebas Neue, Montserrat, Inter, sans-serif",
    fontSize: 96,
    strokeWidth: 0,
    shadowOpacity: 0,
    verticalPosition: 0.5,
    textCase: "lower",
    bold: true,
    letterSpacing: -2,
    cluster: {
      heroScale: 2.6,
      scatterRadius: 240,
      maxRotationDeg: 8,
    },
  },
};

export const DEFAULT_STYLE: CaptionStyleId = "captora-glow";

export function applyStyleOverrides(
  base: CaptionStyle,
  overrides: CaptionStyleOverrides | undefined
): CaptionStyle {
  if (!overrides) return base;
  return { ...base, ...overrides };
}

export function rgbToCss([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
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
