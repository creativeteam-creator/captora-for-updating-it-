import React from "react";
import { interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { CaptionStyle, rgbToCss } from "../styles";
import { WhisperWord } from "../types";

interface Props {
  word: WhisperWord;
  index: number;
  isActive: boolean;
  style: CaptionStyle;
}

/**
 * One word, anchored at the absolute center, with:
 * - Pop-in scale 0 → 100% over `style.popInDurationSec` (relative to its own start frame).
 * - Fade-out at end via opacity ramp.
 * - Color = highlightColor when this is the active word, baseColor otherwise.
 *
 * The frame math is local — Sequence's `from={...}` shifts the timeline so
 * `useCurrentFrame()` reads 0 at this word's start.
 */
export function WordCaption({ word, isActive, style }: Props) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const wordDurationFrames = Math.max(1, Math.round((word.end - word.start) * fps));
  const popInFrames = Math.max(
    1,
    Math.min(wordDurationFrames - 1, Math.round(style.popInDurationSec * fps))
  );

  const scale = spring({
    frame,
    fps,
    config: { damping: 12, stiffness: 200, mass: 0.6 },
    durationInFrames: popInFrames,
  });

  // Fade-out only when the word is long enough to actually have a hold +
  // fade region. Short words (Whisper sometimes emits 0.10–0.20s words like
  // "to") just pop in and hold at full opacity — no fade.
  const fadeFrames = 3;
  const canFade = wordDurationFrames > popInFrames + fadeFrames + 1;
  const opacity = canFade
    ? interpolate(
        frame,
        [0, popInFrames, wordDurationFrames - fadeFrames, wordDurationFrames],
        [0, 1, 1, 0],
        { extrapolateRight: "clamp" }
      )
    : interpolate(frame, [0, popInFrames], [0, 1], {
        extrapolateRight: "clamp",
      });

  const color = rgbToCss(isActive ? style.highlightColor : style.baseColor);
  const stroke = `${style.strokeWidth}px black`;
  const horizontalPosition = style.horizontalPosition ?? 0.5;

  return (
    <div
      style={{
        position: "absolute",
        left: `${horizontalPosition * 100}%`,
        top: `${style.verticalPosition * 100}%`,
        transform: `translate(-50%, -50%) scale(${scale})`,
        opacity,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: 900,
        color,
        WebkitTextStroke: stroke,
        textShadow: `0 4px 12px rgba(0, 0, 0, ${style.shadowOpacity})`,
        whiteSpace: "nowrap",
        letterSpacing: "0.01em",
        textTransform: "uppercase",
      }}
    >
      {word.word}
    </div>
  );
}
