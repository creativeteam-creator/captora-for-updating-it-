import React from "react";
import { interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { CaptionStyle, rgbToCss } from "../styles";
import { WhisperWord } from "../types";
import type { EntranceVariant, WordEntranceVariant } from "../lib/entranceVariants";

interface Props {
  /** All words in this phrase, in spoken order. */
  words: WhisperWord[];
  /** Phrase start time in absolute seconds (we shift to frame-relative inside). */
  phraseStartSec: number;
  style: CaptionStyle;
  /** How the phrase enters. Cycled by index in `CaptionsTimeline`. */
  variant?: EntranceVariant;
  /** Phrase index in the timeline. Drives `verticalPositionCycle` so each
   *  phrase can land at a different Y. */
  phraseIndex?: number;
  /** Per-word fontSize multipliers keyed by `(word.start * 100) | 0`
   *  centiseconds. When a word's key is set, its rendered fontSize is
   *  `style.fontSize * multiplier`. Words with no entry use the regular
   *  fontSize. */
  wordSizes?: Record<string, number>;
}

/**
 * Renders a whole phrase on screen at once, with the currently-spoken word
 * coloured + scaled-up. Word switching reads the absolute timestamp from
 * `useCurrentFrame()` so each frame stands on its own.
 *
 * Phrase entrance varies via `variant` so consecutive phrases don't all use
 * the same pop-in. Exit is a simple linear fade for all variants — exits
 * are less noticeable than entrances, and a uniform exit keeps the rhythm
 * consistent across phrase transitions.
 */
export function PhraseCaption({ words, phraseStartSec, style, variant = "pop", phraseIndex = 0, wordSizes }: Props) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phraseEndSec = words[words.length - 1].end;
  const phraseDurationSec = Math.max(0.1, phraseEndSec - phraseStartSec);
  const phraseDurationFrames = Math.max(1, Math.round(phraseDurationSec * fps));

  // Resolve the active word from the current frame's absolute time.
  //
  // WHY THE ANTICIPATION OFFSET?
  // Whisper (all variants — GPU, Groq, Sarvam, local) measures word start
  // times at acoustic detection, which lags the perceptual onset of the
  // word by ~80–150 ms — longer for Hindi / mixed-language clips where
  // the model needs more context to confirm a phone.
  //
  // Without an offset the highlight arrives noticeably after the word is
  // already audible.  Adding ~100 ms makes the highlight lead the measured
  // timestamp slightly, which is how CapCut, Submagic, and VEED all feel
  // "perfectly in sync" to viewers.
  //
  // `style.wordAnticipationSec` (optional) lets per-style or per-project
  // tuning override the constant.  The TextPanel exposes a slider.
  const WORD_ANTICIPATION_SEC = style.wordAnticipationSec ?? 0.10;
  const tAbsoluteSec = frame / fps + phraseStartSec;
  // Shift time FORWARD by anticipation so the comparison fires earlier.
  const tForLookup = tAbsoluteSec + WORD_ANTICIPATION_SEC;

  let activeIdx = -1;
  for (let i = 0; i < words.length; i++) {
    if (tForLookup >= words[i].start && tForLookup < words[i].end) {
      activeIdx = i;
      break;
    }
  }
  // Fallback: last word whose start has been reached (covers gaps between words).
  if (activeIdx === -1) {
    for (let i = words.length - 1; i >= 0; i--) {
      if (tForLookup >= words[i].start) {
        activeIdx = i;
        break;
      }
    }
  }
  if (activeIdx === -1) activeIdx = 0;

  // Entrance length in frames — driven by the style's pop-in setting so
  // templates with snappy entrances stay snappy across all variants.
  const entranceFrames = Math.max(2, Math.round(style.popInDurationSec * fps * 1.4));

  // Compute per-variant entrance transform + opacity. Each variant starts
  // at its "off-state" on frame 0 and lands at the resting pose by
  // `entranceFrames`.
  const { entranceTransform, entranceScale, entranceOpacity } = computeEntrance(
    variant,
    frame,
    fps,
    entranceFrames
  );

  // Phrase exit fade — uniform across variants.
  const fadeFrames = 4;
  const canFade = phraseDurationFrames > entranceFrames + fadeFrames + 1;
  const exitOpacity = canFade
    ? interpolate(
        frame,
        [phraseDurationFrames - fadeFrames, phraseDurationFrames],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      )
    : 1;

  const opacity = entranceOpacity * exitOpacity;

  // Text-property resolution. Defaults preserve the legacy
  // "uppercase + bold-900 + 0.01em letter-spacing + lineHeight 1.05" look
  // so untouched templates render identically. Per-style overrides:
  //   textCase upper/lower/sentence
  //   bold (true → 900, false → 700)
  //   italic, underline
  //   lineHeight, letterSpacing
  //   textAlign left/center/right
  const textTransform =
    style.textCase === "lower"
      ? "lowercase"
      : style.textCase === "sentence"
        ? "none"
        : "uppercase";
  const fontWeight = style.bold === false ? 700 : 900;
  const fontStyle = style.italic ? "italic" : "normal";
  const textDecoration = style.underline ? "underline" : "none";
  const letterSpacing =
    typeof style.letterSpacing === "number"
      ? `${style.letterSpacing}px`
      : "0.01em";
  const lineHeight = style.lineHeight ?? 1.05;
  const textAlign = style.textAlign ?? "center";

  const baseStroke = style.strokeWidth > 0 ? `${style.strokeWidth}px black` : "none";
  const baseColor = rgbToCss(style.baseColor);
  const highlightColor = rgbToCss(style.highlightColor);
  const inactiveBoxColor = style.boxInactiveColor ? rgbToCss(style.boxInactiveColor) : baseColor;

  // Resolve vertical position — `verticalPositionCycle` rotates per phrase
  // index for templates like Bouncy Mix. Falls back to the static value.
  const verticalPosition =
    style.verticalPositionCycle && style.verticalPositionCycle.length > 0
      ? style.verticalPositionCycle[phraseIndex % style.verticalPositionCycle.length]
      : style.verticalPosition;
  const horizontalPosition = style.horizontalPosition ?? 0.5;

  // Build the phrase-level textShadow (drop shadow + optional "all-words" glow).
  // The active-word glow is applied per-word inside the word loop below.
  const phraseShadows: string[] = [];
  if ((style.shadowOpacity ?? 0) > 0 || style.dropShadowColor) {
    const sOX = style.dropShadowOffsetX ?? 0;
    const sOY = style.dropShadowOffsetY ?? 4;
    const sBlur = style.dropShadowBlur ?? 12;
    const sColor = style.dropShadowColor
      ? `rgba(${Math.round(style.dropShadowColor[0] * 255)}, ${Math.round(style.dropShadowColor[1] * 255)}, ${Math.round(style.dropShadowColor[2] * 255)}, ${style.shadowOpacity ?? 0.75})`
      : `rgba(0, 0, 0, ${style.shadowOpacity})`;
    phraseShadows.push(`${sOX}px ${sOY}px ${sBlur}px ${sColor}`);
  }
  const glowMode = style.glowMode ?? (style.glowOnActive ? "active" : "none");
  if (glowMode === "all") {
    const glowRGB = style.glowColor ?? style.highlightColor;
    const glowBlur = style.glowBlur ?? 24;
    const gColor = `rgba(${Math.round(glowRGB[0] * 255)}, ${Math.round(glowRGB[1] * 255)}, ${Math.round(glowRGB[2] * 255)}, 0.85)`;
    phraseShadows.push(`0 0 ${glowBlur}px ${gColor}`);
    phraseShadows.push(`0 0 ${Math.round(glowBlur / 2)}px ${gColor}`);
  }
  const phraseTextShadow = style.boxBackground
    ? "none"
    : phraseShadows.length > 0 ? phraseShadows.join(", ") : "none";

  const boxStyle: React.CSSProperties | undefined = style.boxBackground
    ? {
        backgroundColor: rgbToCss(style.boxBackground.color),
        padding: `${style.boxBackground.paddingY}px ${style.boxBackground.paddingX}px`,
        borderRadius: style.boxBackground.radius,
        boxShadow: `0 8px 32px rgba(0, 0, 0, ${style.shadowOpacity})`,
      }
    : undefined;

  // When the template uses per-word entrances, suppress the phrase-level
  // entrance — otherwise both fire at phrase start and the words appear
  // pre-animated (the phrase already pop'd in, so the per-word slide/blur
  // looks weak). Per-word IS the entrance.
  const hasWordEntrance =
    !!style.wordEntrance &&
    !(typeof style.wordEntrance === "string" && style.wordEntrance === "none") &&
    !(Array.isArray(style.wordEntrance) && style.wordEntrance.length === 0);

  const phraseTransform = hasWordEntrance ? "" : entranceTransform;
  const phraseScale = hasWordEntrance ? 1 : entranceScale;
  const phraseOpacity = hasWordEntrance ? exitOpacity : opacity;

  // Compose the final transform. Order matters: anchoring translate first,
  // then the variant's transform (slide / tilt), then the variant's scale.
  const composedTransform = [
    "translate(-50%, -50%)",
    phraseTransform,
    `scale(${phraseScale})`,
  ]
    .filter(Boolean)
    .join(" ");

  // Stagger layout: pre-split the phrase into rows so we can give each
  // its own alignment (top → left, middle → center, bottom → right).
  // Without this all rows inherit the parent's `justify-content` and
  // wind up uniformly centered. Phrases of 1-2 words skip the split —
  // there's nothing visually meaningful to stagger.
  const isStaggered = style.rowAlignment === "stagger" && words.length > 2;
  const rows = isStaggered ? splitPhraseIntoRows(words, 3) : [words];

  // Running absolute index per row so the inner word loop can keep its
  // existing per-word logic (active highlight, word entrance) unchanged.
  const rowStartIdx: number[] = [];
  {
    let acc = 0;
    for (const r of rows) {
      rowStartIdx.push(acc);
      acc += r.length;
    }
  }

  const wordGap = style.perWordChip ? "0.4em" : "0.35em";

  return (
    <div
      style={{
        position: "absolute",
        left: `${horizontalPosition * 100}%`,
        top: `${verticalPosition * 100}%`,
        transform: composedTransform,
        opacity: phraseOpacity,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight,
        fontStyle,
        textDecoration,
        WebkitTextStroke: baseStroke,
        textShadow: phraseTextShadow,
        letterSpacing,
        textTransform,
        textAlign,
        maxWidth: "85%",
        lineHeight,
        display: "flex",
        flexDirection: "column",
        gap: "0.05em",
        // Non-stagger collapses to a single child row, but still needs
        // to center the column itself horizontally.
        alignItems: "stretch",
        ...boxStyle,
      }}
    >
      {rows.map((row, rowIdx) => {
        const justify = isStaggered
          ? alignForRow(rowIdx, rows.length)
          : "center";
        return (
          <div
            key={rowIdx}
            style={{
              display: "flex",
              // Non-stagger keeps the legacy wrap-behaviour so long
              // phrases still wrap naturally; stagger nowraps to honour
              // our pre-computed row split.
              flexWrap: isStaggered ? "nowrap" : "wrap",
              justifyContent: justify,
              gap: wordGap,
              alignItems: "baseline",
            }}
          >
      {row.map((wordRel, jRel) => {
        const i = rowStartIdx[rowIdx] + jRel;
        const w = wordRel;
        const isActive = i === activeIdx;
        const inactiveColor = style.boxBackground ? inactiveBoxColor : baseColor;

        const useGradient = isActive && style.highlightGradient && !style.boxBackground;
        const gradientFrom = style.highlightGradient ? rgbToCss(style.highlightGradient.from) : highlightColor;
        const gradientTo = style.highlightGradient ? rgbToCss(style.highlightGradient.to) : highlightColor;

        // Per-word entrance — fires at this word's own start time so the
        // phrase doesn't pop in all at once. Composes WITH the active-
        // word highlight scale (1.15) by multiplying scales.
        const wordVariant = pickWordVariantForIndex(style.wordEntrance, i);
        const wordEntranceFrames = Math.max(
          2,
          Math.round((style.wordEntranceDurationSec ?? 0.18) * fps)
        );
        const wordStartFrameInPhrase = Math.max(
          0,
          Math.round((w.start - phraseStartSec) * fps)
        );
        const wordEntrance = computeWordEntrance(
          wordVariant,
          frame,
          fps,
          wordStartFrameInPhrase,
          wordEntranceFrames
        );

        const activeScale = isActive ? 1.15 : 1;
        const composedScale = activeScale * wordEntrance.scale;
        const composedTransform = [
          wordEntrance.transform,
          `scale(${composedScale})`,
        ]
          .filter(Boolean)
          .join(" ");

        // Per-word fontSize multiplier — keyed by `(word.start * 100) | 0`
        // centiseconds. Default 1.0 = use the inherited phrase fontSize.
        const wordKey = String((w.start * 100) | 0);
        const wordSizeMul = wordSizes?.[wordKey];
        const perWordFontSize =
          typeof wordSizeMul === "number" && wordSizeMul > 0
            ? style.fontSize * wordSizeMul
            : undefined;

        const wordStyle: React.CSSProperties = {
          color: isActive ? highlightColor : inactiveColor,
          transform: composedTransform,
          transformOrigin: "center bottom",
          display: "inline-block",
          opacity: wordEntrance.opacity,
          filter: wordEntrance.filter,
          // Per-word fontSize override (only set when a multiplier exists,
          // otherwise the inherited fontSize wins).
          fontSize: perWordFontSize,
          // Active-word glow — only when glowMode is "active" (or legacy
          // glowOnActive). The "all" mode is already applied at the phrase
          // level above; "none" suppresses everything.
          textShadow:
            isActive && glowMode === "active"
              ? (() => {
                  const g = style.glowColor ?? style.highlightColor;
                  const blur = style.glowBlur ?? 18;
                  const c = `rgba(${Math.round(g[0] * 255)}, ${Math.round(g[1] * 255)}, ${Math.round(g[2] * 255)}, 0.9)`;
                  return `0 0 ${blur}px ${c}, 0 0 ${Math.round(blur / 3)}px ${c}`;
                })()
              : undefined,
        };

        if (useGradient) {
          wordStyle.background = `linear-gradient(180deg, ${gradientFrom} 0%, ${gradientTo} 100%)`;
          wordStyle.WebkitBackgroundClip = "text";
          wordStyle.WebkitTextFillColor = "transparent";
          wordStyle.filter = `drop-shadow(0 2px 0 black) drop-shadow(0 -1px 0 black)`;
        }

        // Per-word chip — wraps each word in its own coloured pill. Active
        // word's chip uses `highlightColor`, inactive uses `boxInactiveColor`
        // (or a soft fallback). The text colour inside flips so it stays
        // readable on the chip background.
        if (style.perWordChip) {
          const chipBg = isActive ? highlightColor : inactiveColor;
          // Auto-pick a readable text colour: dark text on bright chip,
          // light text on dark chip.
          const chipBrightness = isActive
            ? style.highlightColor[0] + style.highlightColor[1] + style.highlightColor[2]
            : (style.boxInactiveColor ?? style.baseColor)[0] +
              (style.boxInactiveColor ?? style.baseColor)[1] +
              (style.boxInactiveColor ?? style.baseColor)[2];
          const chipText = chipBrightness > 1.6 ? "rgb(20, 20, 25)" : "rgb(255, 255, 255)";
          wordStyle.background = chipBg;
          wordStyle.color = chipText;
          wordStyle.padding = `${style.perWordChip.paddingY}px ${style.perWordChip.paddingX}px`;
          wordStyle.borderRadius = style.perWordChip.radius;
          wordStyle.WebkitTextFillColor = chipText;
          wordStyle.WebkitBackgroundClip = "border-box";
        }

        return (
          <span key={`${w.start}-${i}`} style={wordStyle}>
            {w.word}
          </span>
        );
      })}
            </div>
          );
        })}
    </div>
  );
}

/** Helper: pick `justify-content` for row `idx` of a staggered phrase. */
function alignForRow(idx: number, total: number): React.CSSProperties["justifyContent"] {
  if (total <= 1) return "center";
  if (idx === 0) return "flex-start";
  if (idx === total - 1) return "flex-end";
  return "center";
}

/**
 * Split a phrase's words into N visually-balanced rows by character
 * count. Used by the "stagger" row-alignment mode so we can give each
 * row its own `justify-content`. Last row absorbs whatever's left so a
 * remainder doesn't strand a single short word on its own line.
 */
function splitPhraseIntoRows(
  words: WhisperWord[],
  rowCount: number
): WhisperWord[][] {
  if (words.length <= 1 || rowCount <= 1) return [words];
  if (words.length <= rowCount) return words.map((w) => [w]);

  const totalChars = words.reduce(
    (sum, w) => sum + Math.max(1, w.word.length) + 1,
    0
  );
  const targetPerRow = totalChars / rowCount;

  const out: WhisperWord[][] = [];
  let current: WhisperWord[] = [];
  let currentChars = 0;
  for (const w of words) {
    current.push(w);
    currentChars += Math.max(1, w.word.length) + 1;
    if (
      currentChars >= targetPerRow &&
      out.length < rowCount - 1 &&
      current.length > 0
    ) {
      out.push(current);
      current = [];
      currentChars = 0;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Resolve a phrase's entrance pose (transform + scale + opacity) for the
 * current frame. Each variant lands at the resting pose by `entranceFrames`.
 */
function computeEntrance(
  variant: EntranceVariant,
  frame: number,
  fps: number,
  entranceFrames: number
): { entranceTransform: string; entranceScale: number; entranceOpacity: number } {
  // Common helper: 0 → 1 progress over the entrance window.
  const progress = (mid: number = 1) =>
    interpolate(frame, [0, entranceFrames], [0, mid], { extrapolateRight: "clamp" });
  const fadeIn = interpolate(frame, [0, entranceFrames], [0, 1], { extrapolateRight: "clamp" });

  switch (variant) {
    case "pop": {
      const scale = spring({
        frame,
        fps,
        config: { damping: 12, stiffness: 200, mass: 0.6 },
        durationInFrames: entranceFrames,
      });
      return { entranceTransform: "", entranceScale: scale, entranceOpacity: 1 };
    }
    case "fade":
      return { entranceTransform: "", entranceScale: 1, entranceOpacity: fadeIn };
    case "slide-up": {
      // Start 40px below the resting position, ease up.
      const dy = interpolate(frame, [0, entranceFrames], [40, 0], { extrapolateRight: "clamp" });
      return {
        entranceTransform: `translateY(${dy}px)`,
        entranceScale: 1,
        entranceOpacity: fadeIn,
      };
    }
    case "slide-down": {
      const dy = interpolate(frame, [0, entranceFrames], [-40, 0], { extrapolateRight: "clamp" });
      return {
        entranceTransform: `translateY(${dy}px)`,
        entranceScale: 1,
        entranceOpacity: fadeIn,
      };
    }
    case "zoom-in": {
      // Start big and shrink to resting size — feels like the phrase rushes
      // toward the camera. Pairs nicely with bold templates.
      const scale = interpolate(frame, [0, entranceFrames], [1.4, 1], { extrapolateRight: "clamp" });
      return { entranceTransform: "", entranceScale: scale, entranceOpacity: fadeIn };
    }
    case "tilt-in": {
      const rot = interpolate(frame, [0, entranceFrames], [-8, 0], { extrapolateRight: "clamp" });
      const scale = interpolate(frame, [0, entranceFrames], [0.92, 1], { extrapolateRight: "clamp" });
      return {
        entranceTransform: `rotate(${rot}deg)`,
        entranceScale: scale,
        entranceOpacity: fadeIn,
      };
    }
    default: {
      // Fallback: harmless fade. Keeps `progress` reachable for tsc when we
      // ever add a variant that needs it.
      progress();
      return { entranceTransform: "", entranceScale: 1, entranceOpacity: fadeIn };
    }
  }
}

/**
 * Resolve which `WordEntranceVariant` to use for the i-th word of a
 * phrase. Accepts either a single variant (every word same), an array
 * (cycle by index), or undefined (no per-word entrance — words appear
 * with the phrase).
 */
function pickWordVariantForIndex(
  cfg: CaptionStyle["wordEntrance"],
  wordIndex: number
): WordEntranceVariant {
  if (!cfg) return "none";
  if (typeof cfg === "string") return cfg as WordEntranceVariant;
  if (cfg.length === 0) return "none";
  return cfg[wordIndex % cfg.length] as WordEntranceVariant;
}

interface WordEntranceComputed {
  transform: string;
  scale: number;
  opacity: number;
  filter?: string;
}

/**
 * Per-word entrance pose at the current frame. Each word starts its
 * animation when `frame` reaches `wordStartFrame`; before that the word
 * is invisible (opacity 0). After `wordStartFrame + entranceFrames` the
 * word is at rest (scale 1, opacity 1, no transform).
 */
function computeWordEntrance(
  variant: WordEntranceVariant,
  frame: number,
  fps: number,
  wordStartFrame: number,
  entranceFrames: number
): WordEntranceComputed {
  // Local frame within the word's entrance window.
  const local = frame - wordStartFrame;

  // Word hasn't appeared yet — keep it hidden so it doesn't ghost in
  // before its time. Exception: "none" variant, which means "no per-word
  // animation" so the word should be visible whenever the phrase is.
  if (variant === "none") {
    return { transform: "", scale: 1, opacity: 1 };
  }
  if (local < 0) {
    return { transform: "", scale: 1, opacity: 0 };
  }

  const fadeIn = interpolate(local, [0, entranceFrames], [0, 1], {
    extrapolateRight: "clamp",
  });

  switch (variant) {
    case "pop": {
      const s = spring({
        frame: local,
        fps,
        config: { damping: 12, stiffness: 220, mass: 0.5 },
        durationInFrames: entranceFrames,
      });
      return { transform: "", scale: s, opacity: 1 };
    }
    case "slide-up": {
      const dy = interpolate(local, [0, entranceFrames], [18, 0], {
        extrapolateRight: "clamp",
      });
      return { transform: `translateY(${dy}px)`, scale: 1, opacity: fadeIn };
    }
    case "slide-down": {
      const dy = interpolate(local, [0, entranceFrames], [-18, 0], {
        extrapolateRight: "clamp",
      });
      return { transform: `translateY(${dy}px)`, scale: 1, opacity: fadeIn };
    }
    case "scale": {
      const s = interpolate(local, [0, entranceFrames], [0.4, 1], {
        extrapolateRight: "clamp",
      });
      return { transform: "", scale: s, opacity: fadeIn };
    }
    case "blur": {
      const px = interpolate(local, [0, entranceFrames], [12, 0], {
        extrapolateRight: "clamp",
      });
      return {
        transform: "",
        scale: 1,
        opacity: fadeIn,
        filter: px > 0.05 ? `blur(${px}px)` : undefined,
      };
    }
    case "rotate": {
      const rot = interpolate(local, [0, entranceFrames], [-15, 0], {
        extrapolateRight: "clamp",
      });
      const s = interpolate(local, [0, entranceFrames], [0.6, 1], {
        extrapolateRight: "clamp",
      });
      return { transform: `rotate(${rot}deg)`, scale: s, opacity: fadeIn };
    }
    case "bounce": {
      // Lower damping for the squishy overshoot.
      const s = spring({
        frame: local,
        fps,
        config: { damping: 7, stiffness: 180, mass: 0.5 },
        durationInFrames: entranceFrames,
      });
      return { transform: "", scale: s, opacity: 1 };
    }
    case "drop": {
      const dy = interpolate(local, [0, entranceFrames], [-40, 0], {
        extrapolateRight: "clamp",
        easing: (t) => 1 - Math.pow(1 - t, 4),
      });
      return { transform: `translateY(${dy}px)`, scale: 1, opacity: fadeIn };
    }
    default:
      return { transform: "", scale: 1, opacity: 1 };
  }
}
