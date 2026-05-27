"use client";

import { useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import {
  BoldViral,
  type CaptionsCompositionProps,
  type WhisperWord,
} from "@captora/remotion";
import type { CaptionStyle, CaptionStyleId } from "@/lib/styles";
import type { UserFont } from "@/lib/userFonts";

/**
 * One stable blob URL per File. Module-level WeakMap so:
 *   - Same `File` reference → same URL across renders (Strict Mode safe).
 *   - URL is never revoked manually; the browser frees it when the File
 *     gets GC'd (closing the tab, or losing the only reference).
 *
 * The earlier useEffect-based pattern revoked URLs on Strict Mode's
 * simulated unmount, which broke <Html5Audio> playback after the first
 * second — the audio element had loaded the (now-revoked) URL.
 */
const FILE_BLOB_URLS = new WeakMap<File, string>();
function getBlobUrl(file: File): string {
  let url = FILE_BLOB_URLS.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    FILE_BLOB_URLS.set(file, url);
  }
  return url;
}

/**
 * Every style uses BoldViral as the host composition. Visual variants
 * flow through the `style` input prop, NOT by swapping composition
 * components. Keeping the component reference stable across template
 * changes is critical: a new component reference makes the Player
 * unmount + remount the whole tree (including <Html5Audio>), which stops
 * audio playback every time the user clicks a different template.
 *
 * /api/render's COMPOSITION_BY_STYLE already does this — preview and
 * render stay one-to-one.
 */
const HOST_COMPONENT: React.FC<CaptionsCompositionProps> = BoldViral;

const AUDIO_EXTS = new Set([
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".wma",
]);

const FPS = 30;
const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;

interface Props {
  file: File;
  ext: string;
  style: CaptionStyleId;
  /** Optional — full computed style (preset + Text panel overrides). When
   *  omitted the composition uses its hardcoded preset. */
  computedStyle?: CaptionStyle;
  words: WhisperWord[];
  durationSec: number;
  /** User-uploaded fonts forwarded into the Player so the embedded
   *  composition's FontLoader can inject @font-face for the live preview. */
  userFonts?: UserFont[];
  /** Output canvas dimensions. Defaults to 1080×1920 (vertical reel) when
   *  omitted — used for audio-only uploads or before dimension probing
   *  resolves. The Player aspect ratio follows these. */
  width?: number;
  height?: number;
  /** Per-line entrance-animation overrides keyed by centisecond start —
   *  forwarded to the composition so the live preview matches what the
   *  rendered MP4 will produce. */
  lineAnimations?: Record<string, string>;
  /** Per-line FULL style overrides — each value is a fully-merged
   *  `CaptionStyle` (preset + global overrides). Lets the composition
   *  render different lines with different templates. */
  lineStyles?: Record<string, CaptionStyle>;
  /** Per-word fontSize multipliers (centisecond-keyed, 1.0 = default). */
  wordSizes?: Record<string, number>;
  /** User-forced line breaks: word indexes after which the captions
   *  grouper must start a new line. Travels as number[] across the
   *  Remotion bundle prop boundary; CaptionsTimeline rebuilds the
   *  Set on the receiving side. */
  userBreaks?: number[];
  /** Optional ref the parent passes in so the new Timeline can read the
   *  Player's current frame and seek to a given frame on click. */
  playerRef?: React.Ref<PlayerRef>;
  /**
   * When true, an overlay captures pointer events so the user can drag
   * anywhere on the preview to reposition the caption block. While
   * inactive (default), the Player's normal click-to-play UI is intact.
   */
  dragModeActive?: boolean;
  /**
   * Called with the new fractional position (0-1) every pointer-move while
   * dragging. Parent stores the value into the global / per-line caption
   * style and the next render reflects it via `computedStyle`.
   */
  onPositionChange?: (x: number, y: number) => void;
}

export function CaptionPreview({
  file, ext, style, computedStyle, words, durationSec, userFonts,
  width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT,
  lineAnimations, lineStyles, wordSizes, userBreaks, playerRef,
  dragModeActive, onPositionChange,
}: Props) {
  // Drag overlay — captures pointer events while `dragModeActive` is true
  // and translates client coords to the [0..1] fractional space the
  // composition expects for caption positioning.
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const positionFromEvent = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragModeActive) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    const pos = positionFromEvent(e.clientX, e.clientY);
    if (pos) onPositionChange?.(pos.x, pos.y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragModeActive || !isDragging) return;
    e.preventDefault();
    const pos = positionFromEvent(e.clientX, e.clientY);
    if (pos) onPositionChange?.(pos.x, pos.y);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragModeActive) return;
    setIsDragging(false);
    try {
      (e.target as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer-capture may already be released */
    }
  };
  // Stable URL per file — see WeakMap above. Synchronous, no effect, so
  // the Player gets a valid URL on the very first render.
  const blobUrl = getBlobUrl(file);
  const isAudio = AUDIO_EXTS.has(ext.toLowerCase());

  // Defensive repair: providers occasionally return broken word timestamps
  // and captions never appear. We catch THREE bad cases and spread words
  // evenly across the audio as a fallback:
  //   1. All zero — model didn't emit word timestamps at all
  //   2. Clustered tiny — all words bunched in <10% of audio duration (this
  //      happens with transformers.js whisper-medium on short audio: the
  //      30-sec chunk pads with silence and the model hallucinates
  //      timestamps in that padding)
  //   3. Out of range — last timestamp exceeds the actual audio duration
  const playableWords = useMemo<WhisperWord[]>(() => {
    if (words.length === 0) return words;
    const ends = words.map((w) => w.end);
    const starts = words.map((w) => w.start);
    const maxEnd = Math.max(...ends);
    const minStart = Math.min(...starts);
    const span = maxEnd - minStart;

    const allZero = ends.every((e) => e === 0);
    const clusteredTiny =
      words.length > 3 && durationSec > 0 && span < durationSec * 0.1;
    const outOfRange = durationSec > 0 && maxEnd > durationSec * 1.2;

    if (!allZero && !clusteredTiny && !outOfRange) return words;

    const totalDur = durationSec > 0 ? durationSec : words.length * 0.4;
    const perWord = totalDur / words.length;
    return words.map((w, i) => ({
      word: w.word,
      start: i * perWord,
      end: (i + 1) * perWord,
    }));
  }, [words, durationSec]);

  // Forward user-uploaded fonts (with resolved signed URLs) so the
  // composition's FontLoader can inject @font-face inside the Player.
  // Only fonts whose URL has loaded are useful — Chromium needs a fetch-
  // able href.
  const customFonts = useMemo(
    () =>
      (userFonts ?? [])
        .filter((f) => !!f.url)
        .map((f) => ({ family: f.family, url: f.url!, format: f.format })),
    [userFonts]
  );

  const inputProps = useMemo<CaptionsCompositionProps>(
    () => ({
      words: playableWords,
      fps: FPS,
      videoSrc: !isAudio && blobUrl ? blobUrl : undefined,
      audioSrc: isAudio && blobUrl ? blobUrl : undefined,
      durationSec,
      style: computedStyle,
      customFonts,
      width,
      height,
      lineAnimations,
      lineStyles,
      wordSizes,
      userBreaks,
    }),
    [playableWords, isAudio, blobUrl, durationSec, computedStyle, customFonts, width, height, lineAnimations, lineStyles, wordSizes, userBreaks]
  );

  const durationInFrames = Math.max(1, Math.ceil((durationSec || 1) * FPS));

  // `style` (the styleId) is intentionally NOT used to pick the component —
  // see HOST_COMPONENT note above. The full styling lives in `inputProps.style`.
  void style;

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-lg border border-[var(--border)] bg-black"
    >
      <Player
        ref={playerRef}
        component={HOST_COMPONENT}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        fps={FPS}
        compositionWidth={width}
        compositionHeight={height}
        style={{ width: "100%", aspectRatio: `${width}/${height}` }}
        controls
        clickToPlay
      />
      {/* Drag overlay — sits on top of the Player and intercepts pointer
          events ONLY while drag mode is active. Outside of drag mode it
          uses pointerEvents=none so the Player's controls work normally. */}
      <div
        className={`absolute inset-0 ${
          dragModeActive
            ? "cursor-crosshair ring-2 ring-[var(--accent)] ring-inset"
            : ""
        }`}
        style={{
          pointerEvents: dragModeActive ? "auto" : "none",
          background: dragModeActive ? "rgba(255,255,255,0.02)" : "transparent",
          touchAction: "none",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {dragModeActive && (
          <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-[var(--accent)]/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-black shadow-lg">
            Drag to position caption
          </div>
        )}
      </div>
    </div>
  );
}
