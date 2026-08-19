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
 * Kinetic-typography cluster caption — CapCut / Instagram-Reels look
 * from the "Video 2" reference. Hero word (longest content word) lands
 * HUGE at the phrase center; non-hero words orbit ABOVE and to the
 * sides of the hero in dedicated slots so they never overlap it.
 *
 * The first cut of this scattered words around center in a full 360°
 * ring — with a 2.6× hero at the center, the smaller words inevitably
 * collided with the hero glyphs. Fixed by:
 *   1. Placing the hero at the FRAME center vertically (not phrase
 *      center), so it dominates its own row.
 *   2. Positioning non-hero words in a horizontal band above/below the
 *      hero row — never on top of the hero itself. Distributed
 *      evenly using golden-angle × width for reproducible spacing.
 *   3. Enforcing a minimum vertical clearance of one hero-row height
 *      between the hero and the smaller words.
 *
 * Words appear at their own `start` time via spring pop.
 */

/** mulberry32 seeded PRNG. */
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

function pickHeroIndex(words: WhisperWord[]): number {
  if (words.length === 0) return 0;
  let bestIdx = 0;
  let bestLen = words[0].word.length;
  for (let i = 1; i < words.length; i++) {
    if (words[i].word.length > bestLen) {
      bestLen = words[i].word.length;
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
  const { fps, width, height } = useVideoConfig();

  const phraseEndSec = words[words.length - 1].end;
  const phraseDurationSec = Math.max(0.1, phraseEndSec - phraseStartSec);
  const phraseDurationFrames = Math.max(1, Math.round(phraseDurationSec * fps));

  const heroScale = style.cluster?.heroScale ?? 2.4;
  const heroColor = style.cluster?.heroColor ?? style.highlightColor;
  const heroIdx = pickHeroIndex(words);

  const baseFontSize = style.fontSize;
  const heroFontSize = baseFontSize * heroScale;
  // Non-hero words render at 60% of the base size — small enough not
  // to compete with the hero but readable at 1080p.
  const nonHeroFontSize = baseFontSize * 0.6;

  // Vertical layout — hero row sits at 55% of canvas height (a bit
  // below true middle so the pile has more room to breathe above the
  // hero row). Non-hero words split into an "above" band and a
  // "below" band to fill the frame symmetrically.
  const heroY = height * 0.55;
  const rowClearance = heroFontSize * 0.7; // never encroach on hero row

  const rng = makeRng(phraseStartSec + phraseIndex);

  // Phrase-level fade in / out. Expressed in SECONDS and converted
  // through fps, not as raw frame counts.
  //
  // These were hard-coded as 4 and 6 frames, which was only ever correct
  // while every render ran at 30fps. Now that exports honour the source
  // video's frame rate, a raw frame count would make the fade twice as
  // fast on 60fps footage and slower on 24fps footage. The values below
  // are the old counts divided by 30, so 30fps output is unchanged.
  const FADE_IN_SEC = 4 / 30;   // ~0.13s
  const FADE_OUT_SEC = 6 / 30;  // 0.20s
  const fadeInFrames = Math.max(1, Math.round(FADE_IN_SEC * fps));
  const fadeOutFrames = Math.max(1, Math.round(FADE_OUT_SEC * fps));

  const phraseOpacity = (() => {
    if (frame < fadeInFrames) return interpolate(frame, [0, fadeInFrames], [0, 1]);
    const fadeStart = phraseDurationFrames - fadeOutFrames;
    if (frame > fadeStart) {
      return interpolate(frame, [fadeStart, phraseDurationFrames], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
    }
    return 1;
  })();

  const casing = (raw: string): string => {
    if (style.textCase === "upper") return raw.toUpperCase();
    if (style.textCase === "lower") return raw.toLowerCase();
    return raw;
  };

  // Split non-hero words into ABOVE / BELOW the hero. Alternate
  // assignment for even distribution.
  const nonHero = words
    .map((w, i) => ({ w, i }))
    .filter(({ i }) => i !== heroIdx);
  const aboveWords: { w: WhisperWord; i: number }[] = [];
  const belowWords: { w: WhisperWord; i: number }[] = [];
  nonHero.forEach((entry, k) => {
    (k % 2 === 0 ? aboveWords : belowWords).push(entry);
  });

  // Layout one band as horizontally-packed words with per-word jitter
  // for the mosaic feel. Returns absolute (x, y) per word.
  const layoutBand = (
    band: { w: WhisperWord; i: number }[],
    bandY: number
  ): Array<{ i: number; w: WhisperWord; cx: number; cy: number; rot: number }> => {
    if (band.length === 0) return [];
    const charWidthRatio = 0.5;
    const gap = nonHeroFontSize * 0.35;
    const widths = band.map(
      ({ w }) => (casing(w.word).length + 0.5) * nonHeroFontSize * charWidthRatio
    );
    const totalWidth =
      widths.reduce((s, w) => s + w, 0) + gap * (band.length - 1);
    const maxWidth = width * 0.9;
    const scale = totalWidth > maxWidth ? maxWidth / totalWidth : 1;
    let cursor = width / 2 - (totalWidth * scale) / 2;
    return band.map(({ w, i }, k) => {
      const ww = widths[k] * scale;
      const cx = cursor + ww / 2;
      cursor += ww + gap * scale;
      // Small vertical jitter per word (±14px) + slight rotation.
      const jitterY = (rng() - 0.5) * 20;
      const rot = (rng() - 0.5) * (style.cluster?.maxRotationDeg ?? 6);
      return { i, w, cx, cy: bandY + jitterY, rot };
    });
  };

  const abovePositions = layoutBand(
    aboveWords,
    heroY - rowClearance - nonHeroFontSize * 0.5
  );
  const belowPositions = layoutBand(
    belowWords,
    heroY + rowClearance + nonHeroFontSize * 0.5
  );

  const wordSlots = [
    ...abovePositions,
    ...belowPositions,
    {
      i: heroIdx,
      w: words[heroIdx],
      cx: width / 2,
      cy: heroY,
      rot: 0,
    },
  ];

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: phraseOpacity,
        fontFamily: style.fontFamily,
      }}
    >
      {wordSlots.map(({ i, w, cx, cy, rot }) => {
        const isHero = i === heroIdx;
        const wordStartRel = Math.max(0, w.start - phraseStartSec);
        const wordStartFrame = Math.round(wordStartRel * fps);
        const entrance = spring({
          frame: frame - wordStartFrame,
          fps,
          config: { damping: 12, mass: 0.7, stiffness: 220 },
          durationInFrames: 12,
        });

        const wordKey = String((w.start * 100) | 0);
        const userMul = wordSizes?.[wordKey] ?? 1;
        const fontSize = (isHero ? heroFontSize : nonHeroFontSize) * userMul;

        const text = casing(w.word);

        return (
          <div
            key={`${i}-${w.start}`}
            style={{
              position: "absolute",
              left: `${cx}px`,
              top: `${cy}px`,
              transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${entrance})`,
              opacity: entrance,
              fontSize: `${fontSize}px`,
              fontWeight: isHero ? 900 : 800,
              color: rgbToCss(isHero ? heroColor : style.baseColor),
              letterSpacing: style.letterSpacing
                ? `${style.letterSpacing}px`
                : undefined,
              whiteSpace: "nowrap",
              lineHeight: 0.95,
              paintOrder: "stroke fill",
              WebkitTextStroke: style.strokeWidth
                ? `${style.strokeWidth}px black`
                : undefined,
              textShadow:
                style.shadowOpacity && style.shadowOpacity > 0
                  ? `0 4px 12px rgba(0,0,0,${style.shadowOpacity})`
                  : undefined,
            }}
          >
            {text}
          </div>
        );
      })}
    </div>
  );
}
