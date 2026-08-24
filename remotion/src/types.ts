export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

import type { CaptionStyle } from "./styles";

export interface CaptionsCompositionProps {
  words: WhisperWord[];
  fps: number;
  /**
   * Optional. Filename inside the bundle's public/ folder. When set, the
   * composition renders this clip as the background (its audio track is
   * included automatically). Mutually exclusive with `audioSrc`.
   */
  videoSrc?: string;
  /**
   * Optional. Filename inside the bundle's public/ folder for an audio-only
   * upload (mp3/wav/m4a/etc). Captions render on a black background and
   * this audio is mixed into the output MP4.
   */
  audioSrc?: string;
  /**
   * Optional. Total media length in seconds. If omitted, the composition
   * derives its length from the last word + a small tail buffer.
   */
  durationSec?: number;
  /**
   * Optional. Full caption style — base preset merged with whatever the
   * editor's Text panel has overridden. When omitted, each composition
   * falls back to its hardcoded preset (used by the Studio mock preview).
   */
  style?: CaptionStyle;
  /**
   * When true, the composition's background is fully transparent so the
   * MP4/WebM render carries an alpha channel (use VP9 / .webm at the
   * renderer for the alpha to actually survive). Lets users overlay the
   * exported file on other footage in their editor.
   */
  transparentBackground?: boolean;
  /**
   * User-uploaded font URLs to inject as @font-face before render begins.
   * Each entry maps a font-family name to a downloadable URL (typically
   * a Supabase signed URL) so the user's brand fonts appear in the MP4
   * even though they're not in the curated Google Fonts catalogue.
   */
  customFonts?: Array<{
    family: string;
    url: string;
    format: "ttf" | "otf" | "woff" | "woff2";
  }>;
  /**
   * Output canvas dimensions. Drives `calculateMetadata` so the same
   * BoldViral / CleanMedical / TechMinimal compositions render at any
   * aspect ratio (9:16 reel, 16:9 youtube, 1:1 square, etc.) instead of
   * the hardcoded 1080×1920 default. When omitted, the registered
   * `<Composition>` width/height applies.
   */
  width?: number;
  height?: number;
  /**
   * Per-line entrance-animation overrides keyed by the line's first-word
   * start time (rounded to centiseconds — `(start * 100) | 0`, so 1.234s
   * → "123"). Lets the user pick a specific entrance per line in the
   * captions panel; lines with no key fall back to the cyclic default
   * (pop → fade → slide-up → zoom-in → slide-down → tilt-in).
   *
   * Centisecond keys are stable across normal word edits — re-typing
   * "transplantar" → "transplant" doesn't shift the line's start time —
   * which is why we don't key by line index (line indices shuffle when
   * the user adds / removes words).
   */
  lineAnimations?: Record<string, string>;
  /**
   * Per-line template overrides — same centisecond keys as
   * `lineAnimations`. Each value is a FULLY COMPUTED `CaptionStyle`
   * object (preset merged with any global overrides) so the renderer
   * doesn't need to re-import the style catalogue. Lines without an
   * entry inherit the composition-level `style` prop. Lets a project
   * mix templates per line (e.g. opening line in Bold Viral, body
   * lines in Captora Glow, closing line in Drop Stack).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lineStyles?: Record<string, any>;
  /**
   * Per-word font-size multipliers keyed by the word's start time in
   * centiseconds (`(word.start * 100) | 0` as a string — same convention
   * as `lineAnimations` / `lineStyles`). 1.0 = use the line / global
   * fontSize; 1.5 = 150%; 0.7 = 70%. Centisecond keys are stable across
   * word edits (changing "transplantar" → "transplant" doesn't shift
   * the start time) so the override survives caption tweaks.
   */
  wordSizes?: Record<string, number>;
  /**
   * User-forced line breaks: indexes in `words[]` after which the
   * captions grouper must start a new line. Travels as `number[]`
   * (Set isn't JSON-serialisable across the Remotion bundle prop
   * boundary). When omitted, the grouper falls back to its natural
   * pause / word-count / duration heuristics only.
   */
  userBreaks?: number[];
  /**
   * Caption grouping mode — "phrase" (default 3-6 word chunks) or
   * "sentence" (whole sentence per line). Mirrors the editor's
   * Captions-panel toggle so the preview and the rendered MP4 group
   * lines exactly the way the captions list displays them.
   *
   * This field was missing while every caller already passed the value,
   * so `captionMode` reached the compositions' props object and was
   * dropped on the floor — sentence mode worked in the captions list
   * and the SRT export but never in the preview or the export.
   */
  captionMode?: "phrase" | "sentence";
}
