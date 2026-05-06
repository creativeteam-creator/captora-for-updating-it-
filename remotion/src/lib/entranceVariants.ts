/**
 * Phrase entrance animation variants. We cycle through these per phrase so
 * the viewer doesn't see the same pop-in over and over for the whole video.
 *
 * Order matters — `CaptionsTimeline` picks the variant via `index % length`,
 * so a video with 6 phrases shows each variant exactly once. Tune the order
 * for visual rhythm: alternating energetic (pop, zoom) with calm (fade,
 * slide-up) avoids monotony.
 */

export type EntranceVariant =
  | "pop"
  | "fade"
  | "slide-up"
  | "zoom-in"
  | "slide-down"
  | "tilt-in";

export const ENTRANCE_VARIANT_CYCLE: EntranceVariant[] = [
  "pop",
  "fade",
  "slide-up",
  "zoom-in",
  "slide-down",
  "tilt-in",
];

export function pickVariant(phraseIndex: number): EntranceVariant {
  return ENTRANCE_VARIANT_CYCLE[phraseIndex % ENTRANCE_VARIANT_CYCLE.length];
}

/**
 * Per-word entrance variants — applied independently to each word as
 * it becomes spoken (driven by `word.start`), so a phrase doesn't pop
 * onto screen all at once. The viewer sees a kinetic-typography feel
 * where words appear one by one with their own animation.
 *
 * Distinct from `EntranceVariant` (phrase-level) because the parameter
 * shapes differ: word entrances are FAST (3-6 frames) since they fire
 * mid-phrase and shouldn't compete with the active-word highlight,
 * whereas phrase entrances run 6-12 frames.
 */
export type WordEntranceVariant =
  | "none"        // Appear with the phrase — current default behaviour.
  | "pop"         // Spring scale 0 → 1.
  | "slide-up"    // translateY +18 → 0 + opacity ramp.
  | "slide-down"  // translateY -18 → 0 + opacity ramp.
  | "scale"       // scale 0.4 → 1 + opacity ramp.
  | "blur"        // filter blur(12px) → blur(0) + opacity ramp.
  | "rotate"      // rotate -15deg → 0 + scale 0.6 → 1.
  | "bounce"      // Bouncier spring with overshoot.
  | "drop";       // translateY -40 → 0 with elastic settle.

/**
 * Default cycle used when a template specifies `wordEntranceCycle: true`
 * without supplying its own list. Mixes a few visually distinct variants
 * so consecutive words don't look identical.
 */
export const DEFAULT_WORD_ENTRANCE_CYCLE: WordEntranceVariant[] = [
  "pop",
  "slide-up",
  "scale",
  "rotate",
  "bounce",
  "blur",
];

export function pickWordVariant(
  cycle: WordEntranceVariant[],
  wordIndex: number
): WordEntranceVariant {
  if (cycle.length === 0) return "none";
  return cycle[wordIndex % cycle.length];
}
