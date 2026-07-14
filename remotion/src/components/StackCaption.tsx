import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig, spring } from "remotion";
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
 * Cumulative "pile-up" caption layout — from the 2.mp4 reference. Each
 * spoken word lands HUGE at the phrase's focal point; older words shrink
 * and drift toward the top-left, forming a growing mosaic where the last
 * ~12 words remain visible in a rough size gradient.
 *
 *   - Word 0 (most recent):       ~2.4× base size, centered
 *   - Word 1 (previous):          ~1.5× base size, offset top-right
 *   - Word 2:                     ~1.0× base size, further top-right
 *   - Word 3..N (older):          progressively smaller, scattered top-left
 *   - Beyond MAX_VISIBLE:         faded out entirely to prevent frame clutter
 *
 * Every third word gets the accent color for the "green punctuation"
 * feel the reference used. Positions are deterministically pseudo-random
 * (seeded by the word's start time) so the layout is stable across scrub
 * and re-render.
 */

const MAX_VISIBLE = 12;

/** mulberry32 seeded PRNG — same as ClusterCaption for consistency. */
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

export function StackCaption({
  words,
  phraseStartSec,
  style,
  phraseIndex = 0,
  wordSizes,
}: Props) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Anticipation offset — same as PhraseCaption so word-active timing
  // feels perceptually right (Whisper measures acoustic detection, not
  // perceptual onset).
  const anticipation = style.wordAnticipationSec ?? 0.10;
  const tSec = frame / fps + phraseStartSec + anticipation;

  // Every word that has already started at this frame.
  const startedIndices: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].start <= tSec) startedIndices.push(i);
  }
  if (startedIndices.length === 0) {
    // Phrase hasn't reached its first word yet — render nothing so we
    // don't flash the previous phrase's residue.
    return null;
  }

  // Most recent word first — the pile grows from newest → oldest.
  const orderedByRecency = [...startedIndices].reverse();
  // Slice at MAX_VISIBLE so a 40-word phrase doesn't spiral into 40
  // shrunken labels covering the whole frame.
  const visible = orderedByRecency.slice(0, MAX_VISIBLE);

  const scatter = style.cluster?.scatterRadius ?? Math.min(width * 0.28, 260);
  const accentColor = style.highlightColor;
  const baseColor = style.baseColor;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: style.fontFamily,
      }}
    >
      {/* Absolute anchor — words position relative to canvas center. */}
      <div style={{ position: "relative", width: 0, height: 0 }}>
        {visible.map((wordIdx, recencyRank) => {
          const w = words[wordIdx];
          const wordStartRel = Math.max(0, w.start - phraseStartSec);
          const wordStartFrame = Math.round(wordStartRel * fps);
          const framesSinceStart = frame - wordStartFrame;

          // Entrance spring — snap in when the word first appears.
          const entrance = spring({
            frame: framesSinceStart,
            fps,
            config: { damping: 14, mass: 0.6, stiffness: 260 },
            durationInFrames: 10,
          });

          // Recency-driven size + position. Newest word is biggest at
          // the focal center; each older word shrinks by ~35% and drifts
          // further toward the top-left of the pile.
          const shrinkFactor = Math.pow(0.62, recencyRank);
          const baseSize = style.fontSize;
          const wordKey = String((w.start * 100) | 0);
          const userMul = wordSizes?.[wordKey] ?? 1;
          const heroMul = style.cluster?.heroScale ?? 2.4;
          const fontSize = baseSize * heroMul * shrinkFactor * userMul;

          // Deterministic scatter seed = word start time so each word's
          // slot in the pile is stable across scrub.
          const rng = makeRng(w.start + phraseIndex * 0.001);
          // Rank 0 sits at the focal center; older ranks drift UP-LEFT
          // (negative x, negative y) with per-rank jitter.
          const rankOffsetX = -recencyRank * 0.11;
          const rankOffsetY = -recencyRank * 0.09;
          const jitterX = (rng() - 0.5) * 0.12;
          const jitterY = (rng() - 0.5) * 0.10;
          const dx = (rankOffsetX + jitterX) * scatter * 2;
          const dy = (rankOffsetY + jitterY) * scatter * 2;

          // Slight rotation on older words only — the focal word stays
          // upright so it reads cleanly.
          const rot =
            recencyRank === 0 ? 0 : (rng() - 0.5) * 6;

          // Fade oldest words toward the tail so the pile doesn't grow
          // to visual noise. Newest ~4 words fully opaque; then a soft
          // ramp to ~0.4 at MAX_VISIBLE.
          const opacityRamp =
            recencyRank <= 3
              ? 1
              : interpolate(
                  recencyRank,
                  [3, MAX_VISIBLE - 1],
                  [1, 0.35],
                  { extrapolateRight: "clamp" }
                );

          // Color cycle — every 3rd word gets the accent color. The
          // reference uses this to break up the visual monotony without
          // demanding the transcript actually track "keywords".
          const useAccent = wordIdx % 3 === 1;
          const wordText = (() => {
            const raw = w.word;
            if (style.textCase === "upper") return raw.toUpperCase();
            if (style.textCase === "lower") return raw.toLowerCase();
            return raw;
          })();

          return (
            <div
              key={`${wordIdx}-${w.start}`}
              style={{
                position: "absolute",
                left: `${dx}px`,
                top: `${dy}px`,
                transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${entrance})`,
                opacity: entrance * opacityRamp,
                fontSize: `${fontSize}px`,
                fontWeight: 900,
                color: rgbToCss(useAccent ? accentColor : baseColor),
                letterSpacing: style.letterSpacing
                  ? `${style.letterSpacing}px`
                  : "-1px",
                whiteSpace: "nowrap",
                lineHeight: 0.95,
                paintOrder: "stroke fill",
                textShadow:
                  style.shadowOpacity && style.shadowOpacity > 0
                    ? `0 4px 16px rgba(0,0,0,${style.shadowOpacity})`
                    : undefined,
              }}
            >
              {wordText}
            </div>
          );
        })}
      </div>
      {/* Suppress unused var warning for `height` — kept in destructure
          because future revisions may clamp scatter to canvas height. */}
      <span style={{ display: "none" }}>{height}</span>
    </div>
  );
}
