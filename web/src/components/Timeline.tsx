"use client";

/**
 * Bottom-rail timeline strip — shows where playback is and where each
 * word lives on the audio timeline.
 *
 *   - Time ruler with second ticks
 *   - One chip per word at its `start` position, width = `end - start`
 *   - Vertical playhead that follows the Player's currentFrame via
 *     `frameupdate` events on the PlayerRef
 *   - Click anywhere on the strip → seek the Player to that point
 *
 * Drag-to-retime, audio waveform, and zoom controls are not in this
 * MVP — the goal here is "show me where I am". Subsequent passes can
 * layer those on without touching the wiring.
 */

import { useEffect, useRef, useState, useMemo } from "react";
import type { PlayerRef } from "@remotion/player";
import type { WhisperWord } from "@/lib/whisper";
import { groupWordsIntoLines } from "@/lib/captions";
import { decodePeaks } from "@/lib/waveform";
import { extractFrames } from "@/lib/videoFrames";

type ChipMode = "word" | "line";

type TrackKind = "captions" | "video" | "audio";

interface Props {
  playerRef: React.RefObject<PlayerRef | null>;
  words: WhisperWord[];
  durationSec: number;
  fps?: number;
  /** Highlights this word's chip when set (sync from CaptionsList edit). */
  activeWordIndex?: number | null;
  /** Click handler when a chip is clicked — lets the editor open that
   *  word for editing. Falls back to plain seek when omitted. */
  onWordClick?: (wordIndex: number) => void;
  /** Optional persistence hook. When provided, dragging a chip's left
   *  or right handle calls this with the new words array (with that
   *  word's start / end retimed). Without it, drag handles are hidden
   *  and chips are click-only. */
  onWordsChange?: (next: WhisperWord[]) => void;
  /** Source media file. When provided, the strip decodes its audio
   *  track once and renders peaks behind the chips so users can spot
   *  silences / loud bursts at a glance. Optional — chips work fine
   *  alone for the audio-disabled path. */
  file?: File;
  /** Currently-selected line key (centisecond). When set, the matching
   *  line chip is visually highlighted; clicking another line chip
   *  changes the selection; clicking the same one again clears it. */
  selectedLineKey?: string | null;
  /** Selection callback — pass `null` to clear the current selection. */
  onSelectLine?: (key: string | null) => void;
  /** User-forced line breaks: word indexes after which the captions
   *  grouper must start a new line. Edited from the timeline strip
   *  via a hover-revealed ⏎ control on each word chip. Same store
   *  the CaptionsList uses, so both surfaces stay in sync. */
  userBreaks?: Set<number>;
  onUserBreaksChange?: (next: Set<number>) => void;
  /** Caption IN / OUT trim points in seconds. Words outside this range
   *  are excluded from both the preview and the rendered MP4. `null`
   *  on either side means "no trim on that end" — captions run from
   *  the start of the video / to the end. */
  captionInSec?: number | null;
  captionOutSec?: number | null;
  onCaptionRangeChange?: (
    inSec: number | null,
    outSec: number | null
  ) => void;
}

const FPS_DEFAULT = 30;
/** Default pixel-density of the strip; user can override with zoom. */
const PX_PER_SEC_DEFAULT = 60;

/** Per-track resize bounds. Below 24px chips/frames disappear; above
 *  240 the track eats more vertical space than is useful. */
const TRACK_MIN_HEIGHT = 24;
const TRACK_MAX_HEIGHT = 240;
/** Default heights per track. Captions are short pills; video shows
 *  small filmstrip thumbs; audio gets the most room since the
 *  waveform reads better with amplitude headroom. */
const TRACK_DEFAULTS: Record<TrackKind, number> = {
  captions: 36,
  video: 50,
  audio: 64,
};
/** Time ruler height — fixed (not resizable) since it's just labels. */
const RULER_HEIGHT = 20;
/** Width of the fixed left "track labels" column. Premiere uses ~80px;
 *  ours is tighter to leave more room for the actual timeline. */
const LABEL_COL_WIDTH = 64;
/** localStorage key — survives reloads. Cheap UX win, no DB write. */
const HEIGHTS_STORAGE_KEY = "captora.timelineTrackHeights";
/** Zoom bounds — tightest gives ~5 sec visible at 1000px; widest gives
 *  ~30 sec at 1000px viewport. Outside this and chips become unusable. */
const PX_PER_SEC_MIN = 12;
const PX_PER_SEC_MAX = 240;
/** Filmstrip thumbnail dimensions. 80×45 = 16:9 mini-frames; we tile
 *  these along the video track at intervals proportional to the
 *  video's duration. */
const FILMSTRIP_THUMB_W = 80;
const FILMSTRIP_THUMB_H = 45;

export function Timeline({
  playerRef,
  words,
  durationSec,
  fps = FPS_DEFAULT,
  activeWordIndex,
  onWordClick,
  onWordsChange,
  file,
  selectedLineKey,
  onSelectLine,
  userBreaks,
  onUserBreaksChange,
  captionInSec,
  captionOutSec,
  onCaptionRangeChange,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [currentSec, setCurrentSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // ── Caption IN / OUT trim ──────────────────────────────────────────
  // Users mark IN and OUT points on the timeline; only words that fall
  // inside [in, out] get rendered. Handy for skipping intros / outros
  // where the audio plays but you don't want the captions overlay.
  //
  // Keyboard shortcuts:
  //   I → mark IN at current playhead
  //   O → mark OUT at current playhead
  //   Shift+I / Shift+O → clear that endpoint
  const markInHere = () => {
    if (!onCaptionRangeChange) return;
    // Clamp: IN can't be after OUT.
    const proposed = currentSec;
    const outClamped =
      captionOutSec != null && proposed >= captionOutSec ? null : captionOutSec;
    onCaptionRangeChange(proposed, outClamped ?? null);
  };
  const markOutHere = () => {
    if (!onCaptionRangeChange) return;
    const proposed = currentSec;
    const inClamped =
      captionInSec != null && proposed <= captionInSec ? null : captionInSec;
    onCaptionRangeChange(inClamped ?? null, proposed);
  };
  const clearIn = () => {
    if (!onCaptionRangeChange) return;
    onCaptionRangeChange(null, captionOutSec ?? null);
  };
  const clearOut = () => {
    if (!onCaptionRangeChange) return;
    onCaptionRangeChange(captionInSec ?? null, null);
  };
  const clearBothRange = () => {
    if (!onCaptionRangeChange) return;
    onCaptionRangeChange(null, null);
  };

  // Global keydown for I / O / Shift+I / Shift+O. Skip when focus is
  // inside an input/textarea so typing "i" in a caption edit doesn't
  // fire the marker.
  useEffect(() => {
    if (!onCaptionRangeChange) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "i") {
        e.preventDefault();
        if (e.shiftKey) clearIn();
        else markInHere();
      } else if (k === "o") {
        e.preventDefault();
        if (e.shiftKey) clearOut();
        else markOutHere();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionInSec, captionOutSec, currentSec, onCaptionRangeChange]);

  // Per-track heights — Premiere-style independent track sizing. Each
  // track (Captions, Video, Audio) has its own row height that the
  // user drags via a 4px handle on its bottom edge. Persisted as a
  // single object in localStorage so all three sizes restore together.
  const [trackHeights, setTrackHeights] = useState<Record<TrackKind, number>>(
    TRACK_DEFAULTS
  );
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(HEIGHTS_STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as Partial<Record<TrackKind, number>>;
      const clamp = (n: number) =>
        Math.max(TRACK_MIN_HEIGHT, Math.min(TRACK_MAX_HEIGHT, n));
      setTrackHeights({
        captions: Number.isFinite(parsed.captions)
          ? clamp(parsed.captions as number)
          : TRACK_DEFAULTS.captions,
        video: Number.isFinite(parsed.video)
          ? clamp(parsed.video as number)
          : TRACK_DEFAULTS.video,
        audio: Number.isFinite(parsed.audio)
          ? clamp(parsed.audio as number)
          : TRACK_DEFAULTS.audio,
      });
    } catch {
      /* localStorage may be disabled (private mode) — fall back to default */
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        HEIGHTS_STORAGE_KEY,
        JSON.stringify(trackHeights)
      );
    } catch {
      /* ignore — persistence is best-effort */
    }
  }, [trackHeights]);

  // Per-track resize drag — same ref-over-state pattern as chip drag
  // so a pointermove doesn't re-render unrelated chips.
  const trackResizeRef = useRef<{
    track: TrackKind;
    startY: number;
    startHeight: number;
  } | null>(null);
  const beginTrackResize = (
    track: TrackKind,
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    e.preventDefault();
    e.stopPropagation();
    trackResizeRef.current = {
      track,
      startY: e.clientY,
      startHeight: trackHeights[track],
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const continueTrackResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = trackResizeRef.current;
    if (!drag) return;
    // Handle sits on the BOTTOM of the track, so drag DOWN grows it.
    const dy = e.clientY - drag.startY;
    const next = Math.max(
      TRACK_MIN_HEIGHT,
      Math.min(TRACK_MAX_HEIGHT, drag.startHeight + dy)
    );
    setTrackHeights((prev) => ({ ...prev, [drag.track]: next }));
  };
  const endTrackResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (trackResizeRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      trackResizeRef.current = null;
    }
  };
  const resetTrack = (track: TrackKind) =>
    setTrackHeights((prev) => ({ ...prev, [track]: TRACK_DEFAULTS[track] }));

  // Overall-strip resize — grabs the panel's top edge and grows /
  // shrinks all three tracks proportionally (so a track that was
  // tallest stays tallest after resize). Mirrors Premiere's behaviour
  // when you drag the panel divider in the workspace.
  const overallResizeRef = useRef<{
    startY: number;
    startHeights: Record<TrackKind, number>;
    startTotal: number;
  } | null>(null);
  const beginOverallResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startTotal =
      trackHeights.captions + trackHeights.video + trackHeights.audio;
    overallResizeRef.current = {
      startY: e.clientY,
      startHeights: { ...trackHeights },
      startTotal,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const continueOverallResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = overallResizeRef.current;
    if (!drag) return;
    // Handle sits at the TOP of the strip → drag UP grows the strip,
    // drag DOWN shrinks it.
    const dy = drag.startY - e.clientY;
    const minTotal = TRACK_MIN_HEIGHT * 3; // every track at least at min
    const maxTotal = TRACK_MAX_HEIGHT * 3;
    const newTotal = Math.max(
      minTotal,
      Math.min(maxTotal, drag.startTotal + dy)
    );
    const scale = newTotal / drag.startTotal;
    const clamp = (n: number) =>
      Math.max(TRACK_MIN_HEIGHT, Math.min(TRACK_MAX_HEIGHT, n));
    setTrackHeights({
      captions: clamp(drag.startHeights.captions * scale),
      video: clamp(drag.startHeights.video * scale),
      audio: clamp(drag.startHeights.audio * scale),
    });
  };
  const endOverallResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (overallResizeRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      overallResizeRef.current = null;
    }
  };
  const resetAllTracks = () => setTrackHeights(TRACK_DEFAULTS);
  // Zoom state — `pxPerSec` controls density of the strip. Buttons in
  // the header step through factors of √2 so each click visibly halves
  // or doubles the visible window without overshooting.
  const [pxPerSec, setPxPerSec] = useState<number>(PX_PER_SEC_DEFAULT);
  // Chip mode — "word" shows each Whisper word individually; "line"
  // collapses them into phrase-level pills using the same grouping the
  // editor's captions panel uses, so chip widths match what the user
  // sees on the left side.
  const [chipMode, setChipMode] = useState<ChipMode>("word");
  const lines = useMemo(
    () => (chipMode === "line" ? groupWordsIntoLines(words) : []),
    [chipMode, words]
  );

  // Drag-to-retime — track which word's edge is being dragged so the
  // mouse-move handler on the strip can update timestamps. Cleared on
  // pointer up. We use a ref (not state) inside the handlers so each
  // mousemove doesn't trigger a re-render of every chip.
  const dragRef = useRef<{
    wordIndex: number;
    edge: "left" | "right";
    originSec: number;
    pointerStartX: number;
  } | null>(null);

  const beginDrag = (
    wordIndex: number,
    edge: "left" | "right",
    e: React.PointerEvent<HTMLSpanElement>
  ) => {
    if (!onWordsChange) return;
    e.stopPropagation();
    e.preventDefault();
    const w = words[wordIndex];
    if (!w) return;
    dragRef.current = {
      wordIndex,
      edge,
      originSec: edge === "left" ? w.start : w.end,
      pointerStartX: e.clientX,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const continueDrag = (e: React.PointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || !onWordsChange) return;
    const dx = e.clientX - drag.pointerStartX;
    const dSec = dx / pxPerSec;
    const target = words[drag.wordIndex];
    if (!target) return;
    // Apply delta + clamp so a word can't:
    //  - end before it starts (min 50ms span),
    //  - reach past its neighbor's edge (no overlap).
    const next = [...words];
    if (drag.edge === "left") {
      const minStart = drag.wordIndex > 0 ? words[drag.wordIndex - 1].end : 0;
      const maxStart = target.end - 0.05;
      const newStart = Math.min(maxStart, Math.max(minStart, drag.originSec + dSec));
      next[drag.wordIndex] = { ...target, start: newStart };
    } else {
      const minEnd = target.start + 0.05;
      const maxEnd =
        drag.wordIndex < words.length - 1
          ? words[drag.wordIndex + 1].start
          : durationSec;
      const newEnd = Math.min(maxEnd, Math.max(minEnd, drag.originSec + dSec));
      next[drag.wordIndex] = { ...target, end: newEnd };
    }
    onWordsChange(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (dragRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragRef.current = null;
    }
  };

  // Audio waveform — decode the source file once, redraw the canvas
  // whenever zoom changes (bucket count = strip width in pixels).
  // Decoding is async; the canvas stays empty until peaks resolve. We
  // ALSO redraw on `currentSec` so the played-portion fill stays in
  // sync with the playhead.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const stripWidthPx = Math.max(durationSec * pxPerSec, 600);

  useEffect(() => {
    if (!file) {
      setPeaks(null);
      return;
    }
    let cancelled = false;
    setWaveformError(null);
    // One peak per pixel — exact match to the canvas width keeps the
    // bar graph crisp without DPR scaling artefacts.
    const buckets = Math.max(64, Math.round(stripWidthPx));
    decodePeaks(file, buckets)
      .then((res) => {
        if (!cancelled) setPeaks(res.peaks);
      })
      .catch((err) => {
        if (!cancelled) {
          setWaveformError(err instanceof Error ? err.message : String(err));
          setPeaks(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file, stripWidthPx]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const playedPx = Math.round(currentSec * pxPerSec);
    const mid = h / 2;
    const barWidth = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const x = i * barWidth;
      const amp = peaks[i] * (h / 2) * 0.9;
      // Played portion uses accent colour; un-played uses muted grey.
      // The split is sample-precise so the playhead "wipes" the
      // waveform exactly under it.
      ctx.fillStyle =
        x < playedPx
          ? "rgba(99, 102, 241, 0.85)"
          : "rgba(148, 163, 184, 0.45)";
      ctx.fillRect(x, mid - amp, Math.max(0.5, barWidth - 0.4), amp * 2);
    }
  }, [peaks, currentSec, pxPerSec]);
  const zoomIn = () =>
    setPxPerSec((px) => Math.min(PX_PER_SEC_MAX, Math.round(px * Math.SQRT2)));
  const zoomOut = () =>
    setPxPerSec((px) => Math.max(PX_PER_SEC_MIN, Math.round(px / Math.SQRT2)));
  const zoomReset = () => setPxPerSec(PX_PER_SEC_DEFAULT);

  // Subscribe to Player events. The Player exposes `frameupdate` (fires
  // on every frame while playing OR when seeking), `play`, and `pause`.
  // We only update state on frame changes — no rAF loop needed.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    const onFrame = (e: { detail: { frame: number } }) => {
      setCurrentSec(e.detail.frame / fps);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    // Initial sync — Player may already be at a non-zero frame on mount.
    setCurrentSec(player.getCurrentFrame() / fps);

    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
    };
  }, [playerRef, fps]);

  // The horizontal scroll position of the strip. We pin it to keep the
  // playhead roughly centered while playing — feels like Premiere /
  // Final Cut. Toggleable in a follow-up if it proves disorienting.
  // (Strip width was computed earlier as `stripWidthPx` so the waveform
  // decoder can pick a matching bucket count; reuse that here.)

  useEffect(() => {
    if (!isPlaying) return;
    const el = stripRef.current;
    if (!el) return;
    const playheadPx = currentSec * pxPerSec;
    const visibleStart = el.scrollLeft;
    const visibleEnd = visibleStart + el.clientWidth;
    // Only auto-scroll when the playhead leaves the visible window —
    // avoid yanking the strip on every frame.
    if (playheadPx < visibleStart + 40 || playheadPx > visibleEnd - 40) {
      el.scrollTo({
        left: Math.max(0, playheadPx - el.clientWidth / 2),
        behavior: "smooth",
      });
    }
  }, [currentSec, isPlaying]);

  const handleStripClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || !playerRef.current) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft;
    const sec = Math.max(0, Math.min(durationSec, x / pxPerSec));
    playerRef.current.seekTo(Math.round(sec * fps));
  };

  // Mouse-wheel handling on the strip:
  //   Plain wheel → horizontal scroll (override native vertical scroll
  //                 so users don't have to hold Shift like a desktop OS).
  //   Ctrl/Cmd + wheel → zoom, anchored around the cursor (the time
  //                 under the pointer stays fixed in screen space, just
  //                 like Premiere / Figma).
  const handleStripWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      // Time the cursor is currently hovering, in seconds.
      const anchorSec = (el.scrollLeft + cursorX) / pxPerSec;
      // Scroll-wheel "down" should zoom OUT (smaller pxPerSec) — same
      // direction as mac trackpad pinch-zoom. Trackpads emit smaller
      // delta values; a simple sign + factor works for both.
      const factor = e.deltaY > 0 ? 1 / 1.15 : 1.15;
      const nextPxPerSec = Math.max(
        PX_PER_SEC_MIN,
        Math.min(PX_PER_SEC_MAX, Math.round(pxPerSec * factor))
      );
      setPxPerSec(nextPxPerSec);
      // Re-anchor: keep the cursor's time fixed in screen space by
      // adjusting scrollLeft so anchorSec lands at the same cursorX.
      // We schedule it on the next tick so the new pxPerSec has been
      // applied and the inner content width has updated.
      requestAnimationFrame(() => {
        const target = anchorSec * nextPxPerSec - cursorX;
        el.scrollLeft = Math.max(0, target);
      });
    } else {
      // Translate vertical wheel deltas into horizontal scroll. Browser
      // already does horizontal-wheel and shift+wheel natively; this
      // adds the convenience of plain-wheel-scrolls-the-strip.
      if (e.deltaY !== 0) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    }
  };

  // Build second-tick markers up to the audio duration. Cap at 600 to
  // avoid generating thousands of DOM nodes for a long lecture.
  const ticks = useMemo(() => {
    const total = Math.min(Math.ceil(durationSec) + 1, 601);
    return Array.from({ length: total }, (_, i) => i);
  }, [durationSec]);

  const playheadLeft = currentSec * pxPerSec;

  // Video filmstrip — extract N evenly-spaced frames once per file
  // (cached). Frame count = how many fit in the strip at THUMB_W
  // pixels each, capped so we never extract more than 60 (15+ second
  // seek time on long videos). Skipped silently for audio-only inputs.
  const isVideoSource = !!file && (file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(file.name));
  const filmstripCount = useMemo(
    () => Math.min(60, Math.max(4, Math.round(stripWidthPx / FILMSTRIP_THUMB_W))),
    [stripWidthPx]
  );
  const [filmstrip, setFilmstrip] = useState<string[] | null>(null);
  useEffect(() => {
    if (!file || !isVideoSource) {
      setFilmstrip(null);
      return;
    }
    let cancelled = false;
    extractFrames(file, filmstripCount, FILMSTRIP_THUMB_W, FILMSTRIP_THUMB_H)
      .then((res) => {
        if (!cancelled) setFilmstrip(res.frames);
      })
      .catch(() => {
        // Filmstrip is decorative — silent failure leaves the video
        // track empty (still resizable, still shows the playhead).
        if (!cancelled) setFilmstrip(null);
      });
    return () => {
      cancelled = true;
    };
  }, [file, isVideoSource, filmstripCount]);

  const totalTracksHeight =
    RULER_HEIGHT +
    trackHeights.captions +
    trackHeights.video +
    trackHeights.audio;

  // ── Minimap scrollbar ───────────────────────────────────────
  // Renders a Premiere-style overview bar below the strip. The
  // "thumb" represents the visible window proportionally to the
  // entire timeline; dragging its body pans, dragging its left or
  // right EDGE zooms (smaller thumb → tighter visible window →
  // higher pxPerSec, like grabbing the playhead borders in Premiere).
  //
  // We mirror the strip's scrollLeft + clientWidth into local state
  // so the minimap re-renders immediately when the user pans via
  // wheel, native scrollbar, or click-to-seek auto-scroll.
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportPx, setViewportPx] = useState(0);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const sync = () => {
      setScrollLeft(el.scrollLeft);
      setViewportPx(el.clientWidth);
    };
    sync(); // initial pull
    el.addEventListener("scroll", sync);
    // ResizeObserver keeps `viewportPx` accurate when the user
    // drags the side panels or the editor window itself resizes.
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, []);

  // Minimap drag state. Three modes: pan (drag thumb body) and
  // zoom-left / zoom-right (drag thumb edges).
  const minimapRef = useRef<HTMLDivElement>(null);
  const minimapDragRef = useRef<{
    mode: "pan" | "zoom-left" | "zoom-right";
    startClientX: number;
    startScrollLeft: number;
    startPxPerSec: number;
    startThumbLeftSec: number;
    startThumbWidthSec: number;
  } | null>(null);

  const beginMinimapDrag = (
    mode: "pan" | "zoom-left" | "zoom-right",
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    const strip = stripRef.current;
    if (!strip) return;
    e.preventDefault();
    e.stopPropagation();
    minimapDragRef.current = {
      mode,
      startClientX: e.clientX,
      startScrollLeft: strip.scrollLeft,
      startPxPerSec: pxPerSec,
      startThumbLeftSec: strip.scrollLeft / pxPerSec,
      startThumbWidthSec: strip.clientWidth / pxPerSec,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const continueMinimapDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = minimapDragRef.current;
    const strip = stripRef.current;
    const minimap = minimapRef.current;
    if (!drag || !strip || !minimap) return;

    // Convert mouse delta in MINIMAP px → seconds. The minimap
    // represents the FULL timeline duration over its full width, so:
    //   secondsPerMinimapPx = durationSec / minimap.clientWidth
    const minimapWidth = minimap.clientWidth;
    if (minimapWidth <= 0 || durationSec <= 0) return;
    const dxPx = e.clientX - drag.startClientX;
    const dSec = (dxPx / minimapWidth) * durationSec;

    if (drag.mode === "pan") {
      // Plain pan — translate the visible window by dSec, clamped so
      // the thumb can't escape the timeline bounds.
      const maxStartSec = Math.max(0, durationSec - drag.startThumbWidthSec);
      const newStartSec = Math.max(0, Math.min(maxStartSec, drag.startThumbLeftSec + dSec));
      strip.scrollLeft = newStartSec * drag.startPxPerSec;
    } else {
      // Zoom — resize the visible window by changing pxPerSec and
      // re-anchoring scrollLeft so the OPPOSITE edge of the thumb
      // stays put. Dragging right edge LEFT → window shrinks → zoom
      // in; dragging right edge RIGHT → window grows → zoom out.
      let newWindowSec: number;
      let newStartSec: number;
      if (drag.mode === "zoom-right") {
        // Right edge moves by dSec; left edge anchored.
        newWindowSec = Math.max(0.5, drag.startThumbWidthSec + dSec);
        newStartSec = drag.startThumbLeftSec;
      } else {
        // zoom-left: left edge moves by dSec; right edge anchored.
        // Window width shrinks/grows by -dSec.
        newWindowSec = Math.max(0.5, drag.startThumbWidthSec - dSec);
        newStartSec = Math.max(0, drag.startThumbLeftSec + dSec);
      }
      // Convert window-in-seconds back to pxPerSec given the strip's
      // current viewport width (== clientWidth).
      const targetPxPerSec = Math.max(
        PX_PER_SEC_MIN,
        Math.min(PX_PER_SEC_MAX, strip.clientWidth / newWindowSec)
      );
      setPxPerSec(targetPxPerSec);
      // RAF so scrollLeft is set after pxPerSec has been applied and
      // the inner content width has updated.
      requestAnimationFrame(() => {
        const s = stripRef.current;
        if (s) s.scrollLeft = newStartSec * targetPxPerSec;
      });
    }
  };

  const endMinimapDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (minimapDragRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      minimapDragRef.current = null;
    }
  };

  // Compute thumb position + width as percentages of the minimap so
  // the JSX stays declarative. Falls back to 100% if the strip is
  // narrower than the viewport (i.e. everything fits, no scroll).
  const minimapThumb = useMemo(() => {
    if (durationSec <= 0 || viewportPx <= 0) {
      return { leftPct: 0, widthPct: 100 };
    }
    const visibleSec = viewportPx / pxPerSec;
    const leftSec = scrollLeft / pxPerSec;
    return {
      leftPct: Math.max(0, Math.min(100, (leftSec / durationSec) * 100)),
      widthPct: Math.max(2, Math.min(100, (visibleSec / durationSec) * 100)),
    };
  }, [scrollLeft, viewportPx, pxPerSec, durationSec]);

  return (
    <div className="flex flex-col border-t border-[var(--border)] bg-[var(--bg-sidebar)]">
      {/* Top-edge OVERALL resize handle. Drag up to grow the whole
          timeline panel; drag down to shrink it. All three tracks
          scale proportionally — a track that was tallest stays
          tallest. Double-click resets every track to its default
          (the per-track ⟲ buttons in the labels still reset just
          one track at a time). */}
      <div
        onPointerDown={beginOverallResize}
        onPointerMove={continueOverallResize}
        onPointerUp={endOverallResize}
        onPointerCancel={endOverallResize}
        onDoubleClick={resetAllTracks}
        title="Drag to resize timeline · double-click to reset all tracks"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline panel"
        className="group relative h-1 shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-[var(--accent)]/40"
      >
        {/* Centered grip dots — purely decorative, makes the handle
            visible even when not hovering. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex h-1 items-center justify-center gap-0.5 opacity-30 group-hover:opacity-100">
          <span className="h-0.5 w-0.5 rounded-full bg-[var(--text-muted)]" />
          <span className="h-0.5 w-0.5 rounded-full bg-[var(--text-muted)]" />
          <span className="h-0.5 w-0.5 rounded-full bg-[var(--text-muted)]" />
        </div>
      </div>

      {/* Top row: play/pause + time readout. */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
        <button
          type="button"
          onClick={() => playerRef.current?.toggle()}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-elevated)] text-[var(--text)] hover:bg-[var(--bg-hover)]"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "❚❚" : "▶"}
        </button>

        {/* Word / Line chip-mode toggle. Word view = per-Whisper-word
            chips for fine timing; Line view = phrase-level pills that
            mirror the captions panel grouping so visual context matches. */}
        <div className="flex overflow-hidden rounded border border-[var(--border)] text-[10px] uppercase tracking-wide">
          <button
            type="button"
            onClick={() => setChipMode("word")}
            className={`px-2 py-0.5 transition ${
              chipMode === "word"
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
            }`}
          >
            Word
          </button>
          <button
            type="button"
            onClick={() => setChipMode("line")}
            className={`px-2 py-0.5 transition ${
              chipMode === "line"
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
            }`}
          >
            Line
          </button>
        </div>

        <span className="font-mono tabular-nums">
          {formatTime(currentSec)} <span className="opacity-60">/ {formatTime(durationSec)}</span>
        </span>

        {/* Caption IN / OUT mark buttons — trim which portion of the
            audio the captions overlay covers. Keyboard: I / O. */}
        {onCaptionRangeChange && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={markInHere}
              title={`Mark IN at ${formatTime(currentSec)} (I)`}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition ${
                captionInSec != null
                  ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                  : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-emerald-500 hover:text-emerald-300"
              }`}
            >
              [ In{captionInSec != null ? ` ${formatTime(captionInSec)}` : ""}
            </button>
            <button
              type="button"
              onClick={markOutHere}
              title={`Mark OUT at ${formatTime(currentSec)} (O)`}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition ${
                captionOutSec != null
                  ? "border-rose-500 bg-rose-500/20 text-rose-300"
                  : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-rose-500 hover:text-rose-300"
              }`}
            >
              Out{captionOutSec != null ? ` ${formatTime(captionOutSec)}` : ""} ]
            </button>
            {(captionInSec != null || captionOutSec != null) && (
              <button
                type="button"
                onClick={clearBothRange}
                title="Clear caption range (both marks)"
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:border-[var(--text)] hover:text-[var(--text)]"
              >
                ×
              </button>
            )}
          </div>
        )}

        <span className="ml-auto text-[10px] uppercase tracking-wide opacity-70">
          Click strip to seek · click chip to edit word
        </span>
        {/* Waveform decode failed (rare — typically an encrypted source
            or a codec the browser can't read). Surface quietly so users
            know the missing peaks are intentional, not a bug. */}
        {waveformError && (
          <span
            className="text-[10px] text-rose-400/80"
            title={waveformError}
          >
            (waveform unavailable)
          </span>
        )}

        {/* Zoom controls — minus / slider / plus / reset. Slider is
            log-scale via the same √2 stepping the buttons use; gives
            silky zoom without the slider feeling crowded near minimum. */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={zoomOut}
            disabled={pxPerSec <= PX_PER_SEC_MIN}
            className="flex h-6 w-6 items-center justify-center rounded bg-[var(--bg-elevated)] text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-30"
            aria-label="Zoom out"
          >
            −
          </button>
          <input
            type="range"
            min={PX_PER_SEC_MIN}
            max={PX_PER_SEC_MAX}
            step={1}
            value={pxPerSec}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
            className="h-1 w-24 accent-[var(--accent)]"
            aria-label="Timeline zoom"
          />
          <button
            type="button"
            onClick={zoomIn}
            disabled={pxPerSec >= PX_PER_SEC_MAX}
            className="flex h-6 w-6 items-center justify-center rounded bg-[var(--bg-elevated)] text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-30"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={zoomReset}
            className="rounded px-2 py-0.5 text-[10px] uppercase tracking-wide hover:bg-[var(--bg-elevated)] hover:text-[var(--text)]"
            aria-label="Reset zoom"
            title={`Reset to ${PX_PER_SEC_DEFAULT} px/sec`}
          >
            {pxPerSec} px/s
          </button>
        </div>
      </div>

      {/* Inline style: Hide the native horizontal scrollbar inside
          the strip — we have the minimap below for that purpose, and
          a double scrollbar would feel cluttered. Per-element so we
          don't change global Tailwind config. */}
      <style>{`
        .captora-timeline-strip::-webkit-scrollbar { height: 0; width: 0; }
        .captora-timeline-strip { scrollbar-width: none; }
      `}</style>

      {/* ── Premiere-style two-column tracks layout ──────────────
          Left column  : fixed track labels (Captions / Video / Audio)
                         + per-track reset buttons. Doesn't scroll
                         horizontally — labels stay visible.
          Right column : shared horizontal scroll holding the time
                         ruler and the three stacked tracks. Each
                         track has its own height (independent
                         resize handle on its bottom edge). The
                         playhead spans all three tracks vertically. */}
      <div className="flex">
        {/* ── Left: track labels ─────────────────────────────── */}
        <div
          className="shrink-0 border-r border-[var(--border)] bg-[var(--bg-sidebar)]"
          style={{ width: `${LABEL_COL_WIDTH}px` }}
        >
          {/* Spacer matching the time ruler */}
          <div
            style={{ height: `${RULER_HEIGHT}px` }}
            className="border-b border-[var(--border)]"
          />
          <TrackLabel
            name="Captions"
            height={trackHeights.captions}
            onReset={() => resetTrack("captions")}
          />
          <TrackLabel
            name="Video"
            height={trackHeights.video}
            onReset={() => resetTrack("video")}
          />
          <TrackLabel
            name="Audio"
            height={trackHeights.audio}
            onReset={() => resetTrack("audio")}
          />
        </div>

        {/* ── Right: scrollable timeline ─────────────────────── */}
        <div
          ref={stripRef}
          onClick={handleStripClick}
          onWheel={handleStripWheel}
          className="captora-timeline-strip relative flex-1 overflow-x-auto overflow-y-hidden bg-[var(--bg)]"
          style={{ height: `${totalTracksHeight}px` }}
        >
          <div
            className="relative"
            style={{
              width: `${stripWidthPx}px`,
              height: `${totalTracksHeight}px`,
            }}
          >
            {/* ── Time ruler ─────────────────────────────────── */}
            <div
              className="relative select-none border-b border-[var(--border)]"
              style={{ height: `${RULER_HEIGHT}px` }}
            >
              {ticks.map((s) => (
                <div
                  key={s}
                  className="absolute top-0 h-full text-[9px] text-[var(--text-muted)]"
                  style={{ left: `${s * pxPerSec}px` }}
                >
                  <div className="h-2 w-px bg-[var(--border)]" />
                  <div className="pl-1">{formatTime(s)}</div>
                </div>
              ))}
            </div>

            {/* ── Track 1: Captions (chips) ──────────────────── */}
            {/* Double-click an empty area of this track to insert a new
                word at that timestamp. The new word lands at the
                clicked position with a 0.4s default duration and
                placeholder text the user immediately edits in
                CaptionsList. Saves users the "transcribe missed a
                word" round-trip — they just drop it in and rename. */}
            <div
              className="relative border-b border-[var(--border)] bg-[var(--bg)]"
              style={{ height: `${trackHeights.captions}px` }}
              onDoubleClick={(e) => {
                if (!onWordsChange) return;
                // Only handle if the user double-clicked the track
                // itself, not a child chip — chips do their own click.
                if (e.target !== e.currentTarget) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const sec = Math.max(0, Math.min(durationSec, x / pxPerSec));
                const newWord: WhisperWord = {
                  word: "new",
                  start: sec,
                  end: Math.min(durationSec, sec + 0.4),
                };
                // Insert at the correct sorted-by-start position so
                // groupWordsIntoLines + PhraseCaption see a clean
                // monotonic sequence.
                const next = words.slice();
                let insertAt = next.findIndex((w) => w.start > sec);
                if (insertAt < 0) insertAt = next.length;
                next.splice(insertAt, 0, newWord);
                onWordsChange(next);
              }}
              title={onWordsChange ? "Double-click to add a new word here" : undefined}
            >
              {chipMode === "word"
                ? words.map((w, i) => {
                    const left = w.start * pxPerSec;
                    const width = Math.max(8, (w.end - w.start) * pxPerSec);
                    const isActive = activeWordIndex === i;
                    return (
                      <div
                        key={`${i}-${w.start}`}
                        className="group absolute top-0.5 bottom-0.5"
                        style={{ left: `${left}px`, width: `${width}px` }}
                      >
                        {onWordsChange && (
                          <span
                            onPointerDown={(e) => beginDrag(i, "left", e)}
                            onPointerMove={continueDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                            className={`absolute left-0 top-0 z-20 h-full w-3 cursor-col-resize rounded-l ${
                              isActive
                                ? "bg-white/40"
                                : "bg-[var(--accent)]/0 group-hover:bg-[var(--accent)]/70"
                            }`}
                            aria-label={`Drag to retime word ${i + 1} start`}
                          />
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            playerRef.current?.seekTo(Math.round(w.start * fps));
                            onWordClick?.(i);
                          }}
                          className={`absolute inset-0 truncate rounded border px-1.5 text-[10px] leading-tight transition ${
                            isActive
                              ? "z-10 border-[var(--accent)] bg-[var(--accent)] text-white"
                              : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text)] hover:border-[var(--accent)]"
                          }`}
                          title={`${w.word} · ${formatTime(w.start)} → ${formatTime(w.end)}`}
                        >
                          {w.word}
                        </button>
                        {onWordsChange && (
                          <span
                            onPointerDown={(e) => beginDrag(i, "right", e)}
                            onPointerMove={continueDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                            className={`absolute right-0 top-0 z-20 h-full w-3 cursor-col-resize rounded-r ${
                              isActive
                                ? "bg-white/40"
                                : "bg-[var(--accent)]/0 group-hover:bg-[var(--accent)]/70"
                            }`}
                            aria-label={`Drag to retime word ${i + 1} end`}
                          />
                        )}
                        {/* Line-break toggle — same userBreaks store as
                            the captions-list ⏎ control, so editing on
                            either surface stays in sync. Positioned
                            just outside the chip's right edge so it
                            sits in the gap to the next chip and never
                            collides with the drag handle. Visible on
                            hover; pinned visible (green) when a break
                            is already set after this word. */}
                        {onUserBreaksChange && i < words.length - 1 && (() => {
                          const breakSet = userBreaks?.has(i) ?? false;
                          return (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const next = new Set(userBreaks ?? []);
                                if (next.has(i)) next.delete(i);
                                else next.add(i);
                                onUserBreaksChange(next);
                              }}
                              className={`absolute left-full top-1/2 z-30 -translate-y-1/2 ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded border text-[8px] leading-none transition ${
                                breakSet
                                  ? "border-[var(--accent)] bg-[var(--accent)] text-black opacity-100"
                                  : "border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] opacity-0 hover:border-[var(--accent)] hover:text-[var(--accent)] group-hover:opacity-100"
                              }`}
                              title={breakSet ? "Remove line break here" : "Break line after this word"}
                              aria-label={`Toggle line break after word ${i + 1}`}
                            >
                              ⏎
                            </button>
                          );
                        })()}
                      </div>
                    );
                  })
                : lines.map((line, lineIdx) => {
                    const lineStart = line.words[0].start;
                    const lineEnd = line.words[line.words.length - 1].end;
                    const left = lineStart * pxPerSec;
                    const width = Math.max(40, (lineEnd - lineStart) * pxPerSec);
                    const isActive =
                      currentSec >= lineStart && currentSec < lineEnd;
                    // Selection key — same centisecond convention used
                    // by lineAnimations / lineStyles so the renderer
                    // and Templates panel agree on what "this line" is.
                    const key = String((lineStart * 100) | 0);
                    const isSelected = selectedLineKey === key;
                    const label = line.words.map((w) => w.word).join(" ");
                    return (
                      <button
                        key={`${lineIdx}-${lineStart}`}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          playerRef.current?.seekTo(Math.round(lineStart * fps));
                          // Toggle selection — clicking the already-
                          // selected line again deselects it, so users
                          // can return to global-template mode without
                          // an extra "clear" button.
                          onSelectLine?.(isSelected ? null : key);
                        }}
                        className={`absolute top-0.5 bottom-0.5 truncate rounded border px-2 text-left text-[10px] leading-tight transition ${
                          isSelected
                            ? "z-20 border-amber-300 bg-amber-300/20 text-amber-100 ring-2 ring-amber-300/60"
                            : isActive
                            ? "z-10 border-[var(--accent)] bg-[var(--accent)] text-white"
                            : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text)] hover:border-[var(--accent)]"
                        }`}
                        style={{ left: `${left}px`, width: `${width}px` }}
                        title={
                          isSelected
                            ? `Selected · click to deselect`
                            : `${label} · ${formatTime(lineStart)} → ${formatTime(lineEnd)}`
                        }
                      >
                        <span className="opacity-60 mr-1">{lineIdx + 1}.</span>
                        {label}
                      </button>
                    );
                  })}
              <TrackResizeHandle
                onPointerDown={(e) => beginTrackResize("captions", e)}
                onPointerMove={continueTrackResize}
                onPointerUp={endTrackResize}
                onPointerCancel={endTrackResize}
                onDoubleClick={() => resetTrack("captions")}
              />
            </div>

            {/* ── Track 2: Video filmstrip ───────────────────── */}
            <div
              className="relative overflow-hidden border-b border-[var(--border)] bg-[var(--bg-elevated)]"
              style={{ height: `${trackHeights.video}px` }}
            >
              {isVideoSource && filmstrip && filmstrip.length > 0 ? (
                // Tile the extracted frames evenly across the strip
                // width. Each thumb covers `(stripWidthPx/count)` px;
                // they're set as background-image so we don't pay per-
                // node React reconciliation for many <img>s.
                filmstrip.map((src, i) => {
                  const w = stripWidthPx / filmstrip.length;
                  return (
                    <div
                      key={i}
                      className="absolute top-0 h-full bg-cover bg-center"
                      style={{
                        left: `${i * w}px`,
                        width: `${w}px`,
                        backgroundImage: `url(${src})`,
                      }}
                    />
                  );
                })
              ) : (
                <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                  {isVideoSource ? "Loading filmstrip…" : "Audio-only project"}
                </div>
              )}
              <TrackResizeHandle
                onPointerDown={(e) => beginTrackResize("video", e)}
                onPointerMove={continueTrackResize}
                onPointerUp={endTrackResize}
                onPointerCancel={endTrackResize}
                onDoubleClick={() => resetTrack("video")}
              />
            </div>

            {/* ── Track 3: Audio waveform ────────────────────── */}
            <div
              className="relative bg-[var(--bg)]"
              style={{ height: `${trackHeights.audio}px` }}
            >
              {file && (
                <canvas
                  ref={canvasRef}
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  style={{ opacity: peaks ? 1 : 0 }}
                />
              )}
              {!peaks && file && (
                <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                  Decoding audio…
                </div>
              )}
              <TrackResizeHandle
                onPointerDown={(e) => beginTrackResize("audio", e)}
                onPointerMove={continueTrackResize}
                onPointerUp={endTrackResize}
                onPointerCancel={endTrackResize}
                onDoubleClick={() => resetTrack("audio")}
              />
            </div>

            {/* ── Caption IN / OUT visual markers + dimmed regions ─
                Emerald IN handle at the left, rose OUT handle at the
                right. The area OUTSIDE the [in, out] range gets a soft
                black overlay so users see at a glance which slice of
                the video will have captions. Handles span all three
                tracks vertically like the playhead. */}
            {captionInSec != null && (
              <>
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-20 bg-black/45"
                  style={{ left: 0, width: `${captionInSec * pxPerSec}px` }}
                />
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-25"
                  style={{ left: `${captionInSec * pxPerSec}px` }}
                >
                  <div className="h-full w-0.5 bg-emerald-400" />
                  <div className="absolute -left-1.5 top-0 rounded-sm bg-emerald-400 px-1 py-0.5 text-[8px] font-bold uppercase text-black">
                    In
                  </div>
                </div>
              </>
            )}
            {captionOutSec != null && (
              <>
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-20 bg-black/45"
                  style={{
                    left: `${captionOutSec * pxPerSec}px`,
                    width: `${Math.max(0, (durationSec - captionOutSec) * pxPerSec)}px`,
                  }}
                />
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-25"
                  style={{ left: `${captionOutSec * pxPerSec}px` }}
                >
                  <div className="h-full w-0.5 bg-rose-400" />
                  <div className="absolute -left-1.5 top-0 rounded-sm bg-rose-400 px-1 py-0.5 text-[8px] font-bold uppercase text-black">
                    Out
                  </div>
                </div>
              </>
            )}

            {/* ── Playhead — spans all three tracks vertically ─ */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-30"
              style={{ left: `${playheadLeft}px` }}
            >
              <div className="h-full w-px bg-[var(--accent)]" />
              <div
                className="absolute -left-1.5 top-0 h-3 w-3 rounded-full bg-[var(--accent)] shadow"
                style={{ transform: "translateY(-4px)" }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Minimap scrollbar ────────────────────────────────────
          Premiere-style overview bar. The full bar represents the
          entire timeline duration; the highlighted "thumb" shows
          the current visible window. Drag the body to pan. Drag
          either edge to zoom (smaller thumb = higher pxPerSec).
          The native horizontal scrollbar inside the strip is
          hidden via the `.captora-timeline-strip` style block above
          so we don't have two competing scrollers. */}
      <div className="flex items-center gap-2 border-t border-[var(--border)] px-2 py-1">
        <span className="w-12 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
          Overview
        </span>
        <div
          ref={minimapRef}
          className="relative h-3 flex-1 overflow-hidden rounded bg-[var(--bg)] ring-1 ring-[var(--border)]"
        >
          {/* Thumb body — drag to pan. Edge handles below absorb
              their own pointer events so dragging the edges doesn't
              also trigger the pan. */}
          <div
            onPointerDown={(e) => beginMinimapDrag("pan", e)}
            onPointerMove={continueMinimapDrag}
            onPointerUp={endMinimapDrag}
            onPointerCancel={endMinimapDrag}
            className="absolute top-0 bottom-0 cursor-grab rounded bg-[var(--accent)]/40 transition-colors hover:bg-[var(--accent)]/60 active:cursor-grabbing"
            style={{
              left: `${minimapThumb.leftPct}%`,
              width: `${minimapThumb.widthPct}%`,
            }}
            title="Drag to pan · drag edges to zoom"
          >
            {/* Left edge — drag to zoom (anchored to the right edge). */}
            <div
              onPointerDown={(e) => beginMinimapDrag("zoom-left", e)}
              onPointerMove={continueMinimapDrag}
              onPointerUp={endMinimapDrag}
              onPointerCancel={endMinimapDrag}
              className="absolute -left-0.5 top-0 z-10 h-full w-1.5 cursor-ew-resize rounded-l bg-[var(--accent)]"
              aria-label="Drag to zoom (left edge)"
            />
            {/* Right edge — drag to zoom (anchored to the left edge). */}
            <div
              onPointerDown={(e) => beginMinimapDrag("zoom-right", e)}
              onPointerMove={continueMinimapDrag}
              onPointerUp={endMinimapDrag}
              onPointerCancel={endMinimapDrag}
              className="absolute -right-0.5 top-0 z-10 h-full w-1.5 cursor-ew-resize rounded-r bg-[var(--accent)]"
              aria-label="Drag to zoom (right edge)"
            />
          </div>
          {/* Faint playhead reflection on the minimap so users can
              see where playback is even when zoomed out. */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--text)]/60"
            style={{
              left: durationSec > 0
                ? `${(currentSec / durationSec) * 100}%`
                : "0%",
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** Left-column label for one track — shows the name + a reset button
 *  so users can snap a track back to its default height. */
function TrackLabel({
  name,
  height,
  onReset,
}: {
  name: string;
  height: number;
  onReset: () => void;
}) {
  return (
    <div
      className="group flex items-center justify-between border-b border-[var(--border)] px-2 text-[10px] uppercase tracking-wide text-[var(--text-muted)]"
      style={{ height: `${height}px` }}
    >
      <span className="truncate">{name}</span>
      <button
        type="button"
        onClick={onReset}
        className="opacity-0 transition group-hover:opacity-100 hover:text-[var(--text)]"
        title={`Reset ${name} height`}
        aria-label={`Reset ${name} track height`}
      >
        ⟲
      </button>
    </div>
  );
}

/** Reusable bottom-edge resize handle for a track. Sits inside the
 *  track's relative container so its `bottom: 0` aligns with the
 *  track's bottom edge regardless of the track's height. */
function TrackResizeHandle({
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onDoubleClick,
}: {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      // 4px tall ribbon along the track's bottom. z-30 wins over the
      // playhead (z-30) and chips (z-10/20) so it's always grabbable.
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={onDoubleClick}
      onClick={(e) => e.stopPropagation()}
      title="Drag to resize · double-click to reset"
      role="separator"
      aria-orientation="horizontal"
      className="absolute inset-x-0 bottom-0 z-40 h-1 cursor-row-resize bg-transparent transition-colors hover:bg-[var(--accent)]/60"
    />
  );
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const mm = Math.floor(sec / 60);
  const ss = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${pad2(mm)}:${pad2(ss)}.${pad2(cs)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
