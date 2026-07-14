import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
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
 * Cumulative "pile-up" caption — from the 2.mp4 reference. As each word
 * is spoken it joins the pile at the bottom of the frame, HUGE. Older
 * words shift UPWARD into shrinking rows so the pile reads as a stack
 * of vertical rows with the newest at bottom and the oldest at top.
 *
 * Row buckets (rank = recency, 0 = newest):
 *   - rank 0..1  → bottom row (yFrac 0.72), size 2.2×
 *   - rank 2..4  → mid-lower row (yFrac 0.55), size 1.4×
 *   - rank 5..8  → mid-upper row (yFrac 0.40), size 0.95×
 *   - rank 9+    → top row (yFrac 0.24), size 0.55×
 *
 * Within each row the words lay out left-to-right using measured char
 * widths so words never overlap horizontally either. That's the fix
 * for the "text piles on itself" bug the first cut had — the scatter
 * radius was too tight so 3-4 words all landed on the hero.
 *
 * Every third word takes the accent color for the CapCut "green
 * punctuation" feel — no keyword tracking required.
 */

const ROW_LAYOUT = [
  { rankMin: 0, rankMax: 1, yFrac: 0.72, sizeMul: 2.2 },
  { rankMin: 2, rankMax: 4, yFrac: 0.55, sizeMul: 1.4 },
  { rankMin: 5, rankMax: 8, yFrac: 0.40, sizeMul: 0.95 },
  { rankMin: 9, rankMax: 16, yFrac: 0.24, sizeMul: 0.55 },
];

const MAX_VISIBLE = 17; // last entry of ROW_LAYOUT capped

/** Rough character-width estimate (px per character) for a given font
 *  size. Anton/Bebas ~0.48× — narrow condensed sans. Used for row
 *  packing so we don't need to measure the DOM. */
const CHAR_WIDTH_RATIO = 0.5;

export function StackCaption({
  words,
  phraseStartSec,
  style,
  phraseIndex = 0,
  wordSizes,
}: Props) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const anticipation = style.wordAnticipationSec ?? 0.10;
  const tSec = frame / fps + phraseStartSec + anticipation;

  const started: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].start <= tSec) started.push(i);
  }
  if (started.length === 0) return null;

  // Recency-ordered: rank 0 = newest word.
  const ranked = [...started].reverse().slice(0, MAX_VISIBLE);

  // Group by row bucket.
  const rowsByIdx = new Map<number, { wordIdx: number; rank: number }[]>();
  ranked.forEach((wordIdx, rank) => {
    const rowIdx = ROW_LAYOUT.findIndex(
      (r) => rank >= r.rankMin && rank <= r.rankMax
    );
    if (rowIdx < 0) return;
    if (!rowsByIdx.has(rowIdx)) rowsByIdx.set(rowIdx, []);
    rowsByIdx.get(rowIdx)!.push({ wordIdx, rank });
  });

  const heroBase = style.cluster?.heroScale ?? 2.2;
  const baseColor = style.baseColor;
  const accentColor = style.highlightColor;

  const casing = (raw: string): string => {
    if (style.textCase === "upper") return raw.toUpperCase();
    if (style.textCase === "lower") return raw.toLowerCase();
    return raw;
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        fontFamily: style.fontFamily,
        overflow: "hidden",
      }}
    >
      {Array.from(rowsByIdx.entries()).map(([rowIdx, wordsInRow]) => {
        const row = ROW_LAYOUT[rowIdx];
        // Words in a row are laid out left-to-right in the ORDER they
        // were spoken (oldest first) so the pile reads temporally.
        const inSpokenOrder = [...wordsInRow].sort(
          (a, b) => a.wordIdx - b.wordIdx
        );

        // Compute font size for this row and pre-measure row width so
        // we can center-align it as a whole.
        const rowFontSize = style.fontSize * heroBase * row.sizeMul * 0.5;
        const gapPx = rowFontSize * 0.25;
        const wordWidths = inSpokenOrder.map(
          ({ wordIdx }) =>
            (casing(words[wordIdx].word).length + 0.5) *
            rowFontSize *
            CHAR_WIDTH_RATIO
        );
        const totalRowWidth =
          wordWidths.reduce((sum, w) => sum + w, 0) +
          gapPx * Math.max(0, inSpokenOrder.length - 1);
        // Clamp to 95% of canvas width so the row never overflows.
        const maxRowWidth = width * 0.95;
        const scaleDown =
          totalRowWidth > maxRowWidth ? maxRowWidth / totalRowWidth : 1;
        const effectiveFontSize = rowFontSize * scaleDown;

        let cursorX = width / 2 - (totalRowWidth * scaleDown) / 2;
        const rowY = height * row.yFrac;

        return (
          <React.Fragment key={`row-${rowIdx}`}>
            {inSpokenOrder.map(({ wordIdx, rank }, i) => {
              const w = words[wordIdx];
              const wordText = casing(w.word);
              const wordWidth = wordWidths[i] * scaleDown;
              const cx = cursorX + wordWidth / 2;
              cursorX += wordWidth + gapPx * scaleDown;

              const wordStartFrame = Math.max(
                0,
                Math.round((w.start - phraseStartSec) * fps)
              );
              const framesSinceStart = frame - wordStartFrame;
              const entrance = spring({
                frame: framesSinceStart,
                fps,
                config: { damping: 14, mass: 0.55, stiffness: 260 },
                durationInFrames: 10,
              });

              const wordKey = String((w.start * 100) | 0);
              const userMul = wordSizes?.[wordKey] ?? 1;

              // Fade opacity toward oldest rows so the top row reads as
              // a memory, not a competitor for attention.
              const rowOpacity =
                rowIdx === 0 ? 1 : rowIdx === 1 ? 0.95 : rowIdx === 2 ? 0.75 : 0.55;

              const useAccent = wordIdx % 3 === 1;

              return (
                <div
                  key={`${wordIdx}-${w.start}`}
                  style={{
                    position: "absolute",
                    left: `${cx}px`,
                    top: `${rowY}px`,
                    transform: `translate(-50%, -50%) scale(${entrance})`,
                    opacity: entrance * rowOpacity,
                    fontSize: `${effectiveFontSize * userMul}px`,
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
            {/* Suppress unused rank var warning */}
            <span style={{ display: "none" }}>
              {wordsInRow.map((w) => w.rank).join(",")}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}
