import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { CaptionStyle } from "../styles";
import { WhisperWord } from "../types";
import { groupWordsIntoLines } from "../lib/captions";
import { ENTRANCE_VARIANT_CYCLE, pickVariant, type EntranceVariant } from "../lib/entranceVariants";
import { PhraseCaption } from "./PhraseCaption";
import { ClusterCaption } from "./ClusterCaption";
import { StackCaption } from "./StackCaption";

interface Props {
  words: WhisperWord[];
  style: CaptionStyle;
  /** Per-line variant overrides — see CaptionsCompositionProps. */
  lineAnimations?: Record<string, string>;
  /** Per-line FULL style overrides (already merged with global
   *  overrides on the writer side). When a line has an entry, that
   *  style wins over the composition-level `style` prop. */
  lineStyles?: Record<string, CaptionStyle>;
  /** Per-word fontSize multipliers keyed by `(word.start * 100) | 0`
   *  centiseconds. Forwarded to PhraseCaption so it can resize specific
   *  words inline without affecting the rest of the line. */
  wordSizes?: Record<string, number>;
  /** User-forced line breaks: word indexes after which the grouper
   *  starts a new line. Travels in as `number[]` (Set isn't JSON-
   *  serialisable through the Remotion bundle prop boundary) and is
   *  rebuilt into a Set before passing to groupWordsIntoLines. */
  userBreaks?: number[];
}

/** Build the centisecond key matching the writer side (page.tsx). */
function lineKey(startSec: number): string {
  return String((startSec * 100) | 0);
}

const VALID_VARIANTS = new Set<string>(ENTRANCE_VARIANT_CYCLE);

/**
 * Look up an override for a line by its first-word start time. Tries an
 * exact key first; falls back to the nearest key within ±50 centiseconds
 * (±500ms). The fuzzy fallback survives small timestamp shifts caused by:
 *   - Whisper re-running (timestamps drift a few centiseconds)
 *   - Multi-word splits where the FIRST token retains the line's start
 *     but cumulative rounding drifts the second/third token
 *   - Word edits that don't touch the line's first word
 *
 * Drops overrides whose stored variant isn't in the current variant
 * catalogue (e.g. an old project saved a since-removed name).
 */
function resolveLineOverride(
  startSec: number,
  table: Record<string, string>
): string | null {
  const exact = table[lineKey(startSec)];
  if (exact && VALID_VARIANTS.has(exact)) return exact;

  const target = Math.round(startSec * 100);
  let best: { delta: number; variant: string } | null = null;
  for (const [k, v] of Object.entries(table)) {
    if (!VALID_VARIANTS.has(v)) continue;
    const delta = Math.abs(Number(k) - target);
    if (delta > 50) continue;
    if (!best || delta < best.delta) best = { delta, variant: v };
  }
  return best?.variant ?? null;
}

/**
 * Same fuzzy lookup pattern but for per-line full-style overrides.
 * Returns the resolved CaptionStyle or null when this line has no
 * entry. Tolerance kept identical to the variant resolver so a line's
 * style + animation overrides survive the same kinds of timestamp
 * drifts.
 */
function resolveLineStyle(
  startSec: number,
  table: Record<string, CaptionStyle>
): CaptionStyle | null {
  const exact = table[lineKey(startSec)];
  if (exact) return exact;

  const target = Math.round(startSec * 100);
  let best: { delta: number; style: CaptionStyle } | null = null;
  for (const [k, v] of Object.entries(table)) {
    const delta = Math.abs(Number(k) - target);
    if (delta > 50) continue;
    if (!best || delta < best.delta) best = { delta, style: v };
  }
  return best?.style ?? null;
}

/**
 * Groups Whisper words into phrases (3–6 words / ~3s windows broken on
 * pauses) and renders each phrase via `PhraseCaption`. Each phrase gets a
 * different entrance animation cycled by index, so the viewer sees variety
 * (pop → fade → slide-up → zoom-in → slide-down → tilt-in → pop → ...).
 *
 * The cycling is deterministic, so re-rendering the same audio always
 * produces the same animation order — useful for previews matching MP4s.
 */
export function CaptionsTimeline({ words, style, lineAnimations, lineStyles, wordSizes, userBreaks }: Props) {
  const { fps } = useVideoConfig();
  // Rebuild the userBreaks Set inside the composition so the renderer's
  // grouper produces the same line splits the editor's captions list
  // displayed. Prop comes in as `number[]` because the Remotion bundle
  // prop bridge doesn't serialise Set instances.
  const breaksSet =
    userBreaks && userBreaks.length > 0 ? new Set(userBreaks) : undefined;
  const lines = groupWordsIntoLines(words, { userBreaks: breaksSet });

  return (
    <AbsoluteFill style={{ backgroundColor: "transparent" }}>
      {lines.map((line, i) => {
        const next = lines[i + 1];
        const phraseStartSec = line.words[0].start;
        const phraseEndSec = line.words[line.words.length - 1].end;
        // Cap how long a phrase is held on screen after its own words
        // finish. Without this cap, a phrase whose `next` neighbour is
        // 30 seconds away (music / silence break in the audio) stays
        // visible across the whole gap. Combined with ElevenLabs
        // hallucinations during that silence, consecutive phrases
        // overlap their hold windows and pile up as a wall of stacked
        // captions. Hold the phrase ≤1.5s past its own end; if the
        // next phrase starts sooner, transition at the next phrase.
        const MAX_HOLD_AFTER_END_SEC = 1.5;
        const cap = phraseEndSec + MAX_HOLD_AFTER_END_SEC;
        const heldUntilSec = next
          ? Math.min(next.words[0].start, cap)
          : phraseEndSec + 0.25;
        const startFrame = Math.round(phraseStartSec * fps);
        const durationFrames = Math.max(1, Math.round((heldUntilSec - phraseStartSec) * fps));
        // User override (per-line dropdown) takes precedence; falls
        // back to the cyclic default. `resolveLineOverride` does fuzzy
        // matching within ±500ms so small timestamp drifts (re-running
        // Whisper, multi-word splits) don't drop a previously-set
        // animation.
        const override = lineAnimations
          ? resolveLineOverride(phraseStartSec, lineAnimations)
          : null;
        const variant: EntranceVariant = override
          ? (override as EntranceVariant)
          : pickVariant(i);

        // Per-line FULL style override — when the user picked a
        // template while a specific line was selected. Falls back to
        // the composition-level `style` prop (the project's default
        // template) when no entry matches.
        const lineStyle: CaptionStyle =
          (lineStyles ? resolveLineStyle(phraseStartSec, lineStyles) : null) ?? style;

        return (
          <Sequence
            key={`${i}-${phraseStartSec}`}
            from={startFrame}
            durationInFrames={durationFrames}
            name={line.words.map((w) => w.word).join(" ")}
          >
            {lineStyle.stack ? (
              <StackCaption
                words={line.words}
                phraseStartSec={phraseStartSec}
                style={lineStyle}
                phraseIndex={i}
                wordSizes={wordSizes}
              />
            ) : lineStyle.cluster ? (
              <ClusterCaption
                words={line.words}
                phraseStartSec={phraseStartSec}
                style={lineStyle}
                phraseIndex={i}
                wordSizes={wordSizes}
              />
            ) : (
              <PhraseCaption
                words={line.words}
                phraseStartSec={phraseStartSec}
                style={lineStyle}
                variant={variant}
                phraseIndex={i}
                wordSizes={wordSizes}
              />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
