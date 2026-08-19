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
  //
  // Expressed in SECONDS and converted through fps. This was a raw
  // `fadeFrames = 3`, which only meant 0.1s while every render was 30fps;
  // now that exports honour the source frame rate it would run at half
  // the duration on 60fps footage. 3/30 keeps 30fps output identical.
  const FADE_OUT_SEC = 3 / 30; // 0.10s
  const fadeFrames = Math.max(1, Math.round(FADE_OUT_SEC * fps));
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

  // Build textShadow as a list. Each effect is a separate shadow that
  // CSS composes top-to-bottom (later layers under earlier layers).
  // Order: drop shadow → glow (so glow is the outer halo).
  const shadows: string[] = [];

  // Drop shadow — uses shadowOpacity if no explicit color, else color directly.
  if ((style.shadowOpacity ?? 0) > 0 || style.dropShadowColor) {
    const sOX = style.dropShadowOffsetX ?? 0;
    const sOY = style.dropShadowOffsetY ?? 4;
    const sBlur = style.dropShadowBlur ?? 12;
    const sColor = style.dropShadowColor
      ? `rgba(${Math.round(style.dropShadowColor[0] * 255)}, ${Math.round(style.dropShadowColor[1] * 255)}, ${Math.round(style.dropShadowColor[2] * 255)}, ${style.shadowOpacity ?? 0.75})`
      : `rgba(0, 0, 0, ${style.shadowOpacity})`;
    shadows.push(`${sOX}px ${sOY}px ${sBlur}px ${sColor}`);
  }

  // Outer glow — controlled by glowMode (new) or glowOnActive (legacy).
  const glowMode = style.glowMode ?? (style.glowOnActive ? "active" : "none");
  const glowApplies =
    glowMode === "all" || (glowMode === "active" && isActive);
  if (glowApplies) {
    const glowRGB = style.glowColor ?? style.highlightColor;
    const glowBlur = style.glowBlur ?? 24;
    const gColor = `rgba(${Math.round(glowRGB[0] * 255)}, ${Math.round(glowRGB[1] * 255)}, ${Math.round(glowRGB[2] * 255)}, 0.85)`;
    // Two stacked shadows = denser, more visible halo.
    shadows.push(`0 0 ${glowBlur}px ${gColor}`);
    shadows.push(`0 0 ${Math.round(glowBlur / 2)}px ${gColor}`);
  }

  const composedTextShadow = shadows.length > 0 ? shadows.join(", ") : "none";

  // Resolve text-property overrides. Defaults match the legacy hard-coded
  // "uppercase + bold-900 + 0.01em letter-spacing" look so existing
  // templates render unchanged when none of the new fields are set.
  const textTransform =
    style.textCase === "lower"
      ? "lowercase"
      : style.textCase === "sentence"
        ? "none"
        : "uppercase"; // default + style.textCase === "upper"
  const fontWeight = style.bold === false ? 700 : 900;
  const fontStyle = style.italic ? "italic" : "normal";
  const textDecoration = style.underline ? "underline" : "none";
  const letterSpacing =
    typeof style.letterSpacing === "number"
      ? `${style.letterSpacing}px`
      : "0.01em";
  // lineHeight only relevant when the word wraps — kept for parity with
  // the phrase renderer so per-word and per-phrase paths agree.
  const lineHeight = style.lineHeight ?? 1.2;

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
        fontWeight,
        fontStyle,
        textDecoration,
        color,
        WebkitTextStroke: stroke,
        paintOrder: "stroke fill",
        textShadow: composedTextShadow,
        whiteSpace: "nowrap",
        letterSpacing,
        lineHeight,
        textTransform,
      }}
    >
      {word.word}
    </div>
  );
}
