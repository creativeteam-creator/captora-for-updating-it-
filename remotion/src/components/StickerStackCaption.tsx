import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
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
 * Vertical "sticker stack" — from the "new" reference video (frames 3, 50, 60).
 * Words stack top-to-bottom on the left side of the frame, one word per
 * line, in spoken order. The newest word gets an accent color + neon
 * glow; older words fade to muted white. Feels like a lyric video's
 * side caption.
 *
 * Alignment defaults to left (matches the reference); style.stickerStack
 * can flip to right for a mirrored variant.
 *
 * Layout limits to MAX_VISIBLE lines — older words fade out at the top
 * so a long phrase doesn't overflow the frame.
 */

const MAX_VISIBLE = 6;

export function StickerStackCaption({
  words,
  phraseStartSec,
  style,
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

  // Visible words: last MAX_VISIBLE in spoken order (top→bottom oldest→newest).
  const visible =
    started.length <= MAX_VISIBLE
      ? started
      : started.slice(started.length - MAX_VISIBLE);

  const side = style.stickerStack?.side ?? "left";
  const accentColor = style.highlightColor;
  const baseColor = style.baseColor;

  // Line-height + font-size setup. Each line = a word rendered as a
  // sticker. Base size is style.fontSize; newest word gets a bump so
  // it visually dominates like the reference.
  const baseSize = style.fontSize;
  const lineHeight = baseSize * 1.15;

  // Vertical block height and its top-of-block Y so the stack anchors
  // to the vertical center of the frame regardless of visible count.
  const blockHeight = visible.length * lineHeight;
  const blockTop = height / 2 - blockHeight / 2;

  // Horizontal margin — 6% inset from the chosen side.
  const marginX = width * 0.06;

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
      }}
    >
      {visible.map((wordIdx, row) => {
        const w = words[wordIdx];
        const isNewest = row === visible.length - 1;
        // Older rows fade progressively; the newest row stays fully bright.
        const rowsFromNewest = visible.length - 1 - row;
        const rowOpacity =
          rowsFromNewest === 0
            ? 1
            : interpolate(rowsFromNewest, [0, MAX_VISIBLE - 1], [0.85, 0.25], {
                extrapolateRight: "clamp",
              });

        // Per-word entrance spring, keyed to when this word first appeared.
        const wordStartFrame = Math.max(
          0,
          Math.round((w.start - phraseStartSec) * fps)
        );
        const entrance = spring({
          frame: frame - wordStartFrame,
          fps,
          config: { damping: 14, mass: 0.5, stiffness: 280 },
          durationInFrames: 10,
        });

        // Size: newest word 1.15× to feel more present; others 1.0×.
        const wordKey = String((w.start * 100) | 0);
        const userMul = wordSizes?.[wordKey] ?? 1;
        const fontSize = baseSize * (isNewest ? 1.15 : 1.0) * userMul;

        const cy = blockTop + row * lineHeight + lineHeight / 2;

        // Newest word gets accent color + neon glow via textShadow layers.
        // Older words keep the base color; no glow.
        const color = rgbToCss(isNewest ? accentColor : baseColor);
        const glow = isNewest
          ? `0 0 12px ${rgbToCss(accentColor)}, 0 0 24px ${rgbToCss(accentColor)}, 0 4px 8px rgba(0,0,0,0.55)`
          : `0 3px 6px rgba(0,0,0,0.6)`;

        return (
          <div
            key={`${wordIdx}-${w.start}`}
            style={{
              position: "absolute",
              top: `${cy}px`,
              left: side === "left" ? `${marginX}px` : undefined,
              right: side === "right" ? `${marginX}px` : undefined,
              transform: `translateY(-50%) scale(${entrance})`,
              transformOrigin: side === "left" ? "left center" : "right center",
              opacity: entrance * rowOpacity,
              fontSize: `${fontSize}px`,
              fontWeight: isNewest ? 900 : 700,
              color,
              textShadow: glow,
              letterSpacing: style.letterSpacing
                ? `${style.letterSpacing}px`
                : "-0.5px",
              whiteSpace: "nowrap",
              lineHeight: 1,
              paintOrder: "stroke fill",
              WebkitTextStroke: style.strokeWidth
                ? `${style.strokeWidth}px black`
                : undefined,
            }}
          >
            {casing(w.word)}
          </div>
        );
      })}
    </div>
  );
}
