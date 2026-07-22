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
 * Neon Pill Bar — from the "new" reference video (frame 45). The whole
 * phrase renders inside a full-width rounded pill with a glowing neon
 * border. The first word (the "keyword") takes the accent color; the
 * rest of the phrase stays white. Border/keyword color cycles per
 * phrase index for the yellow → green → purple rhythm the reference
 * used.
 *
 * Palette rotates through 3 slots — override any of them via
 * style.neonPill.palette. Falls back to a preset [yellow, green,
 * purple] set that matches the reference exactly.
 */

const DEFAULT_PALETTE: [number, number, number][] = [
  [1.0, 0.95, 0.1], // yellow
  [0.3, 1.0, 0.35], // green
  [0.75, 0.35, 1.0], // purple
];

export function NeonPillCaption({
  words,
  phraseStartSec,
  style,
  phraseIndex = 0,
  wordSizes,
}: Props) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  const anticipation = style.wordAnticipationSec ?? 0.10;
  const tSec = frame / fps + phraseStartSec + anticipation;

  // Only render words that have started at this frame — same
  // progressive-reveal behaviour as other caption components.
  const revealed = words.filter((w) => w.start <= tSec);
  if (revealed.length === 0) return null;

  const palette =
    style.neonPill?.palette ?? (DEFAULT_PALETTE as [number, number, number][]);
  const color = palette[phraseIndex % palette.length];
  const colorCss = rgbToCss(color);

  // Phrase-level entrance — the whole pill springs in when the phrase
  // starts; individual words reveal progressively but stay inside the
  // same pill.
  const entrance = spring({
    frame,
    fps,
    config: { damping: 14, mass: 0.6, stiffness: 200 },
    durationInFrames: 14,
  });

  // Exit fade over the last 6 frames of the phrase.
  const phraseEndSec = words[words.length - 1].end;
  const phraseDurationSec = Math.max(0.1, phraseEndSec - phraseStartSec);
  const phraseDurationFrames = Math.max(1, Math.round(phraseDurationSec * fps));
  const fadeStart = phraseDurationFrames - 6;
  const fade =
    frame > fadeStart
      ? interpolate(frame, [fadeStart, phraseDurationFrames], [1, 0], {
          extrapolateRight: "clamp",
        })
      : 1;

  const casing = (raw: string): string => {
    if (style.textCase === "upper") return raw.toUpperCase();
    if (style.textCase === "lower") return raw.toLowerCase();
    return raw;
  };

  // Layout — a horizontally-centered rounded pill. Width auto-fits the
  // content but caps at 90% of canvas width. Height scales with font.
  const fontSize = style.fontSize;
  const pillHeight = fontSize * 1.9;
  const pillPaddingX = fontSize * 0.9;
  const pillRadius = pillHeight / 2;

  const keywordText = casing(revealed[0].word);
  const restText = revealed
    .slice(1)
    .map((w) => casing(w.word))
    .join(" ");

  // Per-word user size multipliers — apply to keyword only for now so
  // the layout stays predictable.
  const keywordKey = String((revealed[0].start * 100) | 0);
  const keywordMul = wordSizes?.[keywordKey] ?? 1;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: entrance * fade,
        fontFamily: style.fontFamily,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: `${fontSize * 0.4}px`,
          maxWidth: `${width * 0.9}px`,
          height: `${pillHeight}px`,
          padding: `0 ${pillPaddingX}px`,
          borderRadius: `${pillRadius}px`,
          border: `2.5px solid ${colorCss}`,
          background: "rgba(0,0,0,0.35)",
          // Neon glow — layered box-shadows in the same accent so the
          // pill looks lit rather than just outlined.
          boxShadow: `0 0 8px ${colorCss}, 0 0 22px ${colorCss}80, inset 0 0 12px ${colorCss}40`,
          transform: `scale(${entrance})`,
        }}
      >
        {/* Left indicator bar — matches the vertical accent line the
            reference used to separate the keyword. */}
        <div
          style={{
            width: "3px",
            height: `${fontSize * 1.2}px`,
            background: colorCss,
            boxShadow: `0 0 6px ${colorCss}`,
            borderRadius: "2px",
          }}
        />
        <span
          style={{
            fontSize: `${fontSize * keywordMul}px`,
            fontWeight: 900,
            color: colorCss,
            textShadow: `0 0 10px ${colorCss}, 0 0 20px ${colorCss}80`,
            letterSpacing: style.letterSpacing
              ? `${style.letterSpacing}px`
              : "-0.5px",
            whiteSpace: "nowrap",
          }}
        >
          {keywordText}
        </span>
        {restText && (
          <span
            style={{
              fontSize: `${fontSize * 0.72}px`,
              fontWeight: 500,
              color: "#e6e6e6",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {restText}
          </span>
        )}
      </div>
    </div>
  );
}
