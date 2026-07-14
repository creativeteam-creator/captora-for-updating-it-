import React from "react";
import { interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { CaptionStyle, rgbToCss } from "../styles";
import { WhisperWord } from "../types";

interface Props {
  words: WhisperWord[];
  phraseStartSec: number;
  style: CaptionStyle;
  phraseIndex?: number;
  wordSizes?: Record<string, number>;
}

/**
 * Kinetic-typography cluster layout — CapCut / Instagram-Reels viral
 * caption style. One "hero" word (usually the longest content word)
 * renders HUGE at the phrase center; the surrounding words scatter
 * around it at pseudo-random offsets with slight rotation. Each word
 * pops in at its own `word.start` time, so the cluster builds up
 * one word at a time as the audio plays.
 *
 * Uses a deterministic pseudo-random offset derived from the phrase
 * start time — same phrase always renders the same layout across
 * previews and renders (avoids the "layout changes every scrub"
 * problem you'd get with Math.random()).
 */

/**
 * Deterministic PRNG — mulberry32. Seeded with the phrase start time
 * so previews and renders match, and each phrase gets its own layout.
 */
function makeRng(seed: number): () => number {
  let s = Math.floor(seed * 1000) | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick the "hero" word — longest non-trivial word wins. */
function pickHeroIndex(words: WhisperWord[]): number {
  if (words.length === 0) return 0;
  let bestIdx = 0;
  let bestLen = words[0].word.length;
  for (let i = 1; i < words.length; i++) {
    const len = words[i].word.length;
    if (len > bestLen) {
      bestLen = len;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function ClusterCaption({
  words,
  phraseStartSec,
  style,
  phraseIndex = 0,
  wordSizes,
}: Props) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const phraseEndSec = words[words.length - 1].end;
  const phraseDurationSec = Math.max(0.1, phraseEndSec - phraseStartSec);
  const phraseDurationFrames = Math.max(1, Math.round(phraseDurationSec * fps));

  const cluster = style.cluster ?? {};
  const heroScale = cluster.heroScale ?? 2.5;
  const scatterRadiusPx = cluster.scatterRadius ?? Math.min(width * 0.32, 300);
  const maxRotationDeg = cluster.maxRotationDeg ?? 8;
  const heroColor = cluster.heroColor ?? style.highlightColor;

  const heroIdx = pickHeroIndex(words);
  const rng = makeRng(phraseStartSec + phraseIndex);

  // Absolute time within this phrase, for driving per-word entrance.
  const tPhraseSec = frame / fps;

  // Phrase-level opacity for entrance / exit — snap in fast, hold, then
  // fade out over the last 6 frames so cut between clusters feels tight.
  const phraseOpacity = (() => {
    if (frame < 4) return interpolate(frame, [0, 4], [0, 1]);
    const fadeStart = phraseDurationFrames - 6;
    if (frame > fadeStart) {
      return interpolate(frame, [fadeStart, phraseDurationFrames], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
    }
    return 1;
  })();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: phraseOpacity,
        fontFamily: style.fontFamily,
      }}
    >
      {/* Anchor point — every word is absolutely positioned relative to
          this centered wrapper, so scatter offsets are around the true
          middle of the canvas regardless of phrase length. */}
      <div style={{ position: "relative", width: 0, height: 0 }}>
        {words.map((w, i) => {
          const isHero = i === heroIdx;
          const wordStartRel = Math.max(0, w.start - phraseStartSec);
          const wordStartFrame = Math.round(wordStartRel * fps);

          // Per-word entrance: spring pop from 0 → 1 scale + opacity.
          // Only fires once the word's start frame is reached.
          const entered = frame >= wordStartFrame;
          const entrance = entered
            ? spring({
                frame: frame - wordStartFrame,
                fps,
                config: { damping: 12, mass: 0.7, stiffness: 220 },
                durationInFrames: 12,
              })
            : 0;

          // Deterministic scatter — same phrase always lays out the same.
          // Hero sits at the anchor; others fan out.
          const angle = rng() * Math.PI * 2;
          const distance = isHero ? 0 : scatterRadiusPx * (0.35 + rng() * 0.65);
          const dx = Math.cos(angle) * distance;
          const dy = Math.sin(angle) * distance * 0.55; // squash vertically
          const rot = isHero ? 0 : (rng() * 2 - 1) * maxRotationDeg;

          // Size — hero gets heroScale multiplier; per-word wordSizes
          // still layer on top if the user tuned individual words.
          const wordKey = String((w.start * 100) | 0);
          const userMul = wordSizes?.[wordKey] ?? 1;
          const baseFontSize = style.fontSize;
          const wordFontSize = isHero
            ? baseFontSize * heroScale * userMul
            : baseFontSize * 0.85 * userMul;

          const wordText = (() => {
            const raw = w.word;
            if (style.textCase === "upper") return raw.toUpperCase();
            if (style.textCase === "lower") return raw.toLowerCase();
            return raw;
          })();

          return (
            <div
              key={`${i}-${w.start}`}
              style={{
                position: "absolute",
                left: `${dx}px`,
                top: `${dy}px`,
                transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${entrance})`,
                opacity: entrance,
                fontSize: `${wordFontSize}px`,
                fontWeight: isHero ? 900 : 800,
                color: rgbToCss(isHero ? heroColor : style.baseColor),
                letterSpacing: style.letterSpacing
                  ? `${style.letterSpacing}px`
                  : undefined,
                whiteSpace: "nowrap",
                lineHeight: 1,
                WebkitTextStroke: style.strokeWidth
                  ? `${style.strokeWidth}px black`
                  : undefined,
                paintOrder: "stroke fill",
                textShadow:
                  style.shadowOpacity && style.shadowOpacity > 0
                    ? `0 4px 12px rgba(0,0,0,${style.shadowOpacity})`
                    : undefined,
              }}
            >
              {wordText}
            </div>
          );
        })}
      </div>
    </div>
  );
}
