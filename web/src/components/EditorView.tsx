"use client";

/**
 * The post-transcribe editor — three-column shell:
 *   - Left:   numbered captions list ("Captions" tab) — Phase 3a only one tab
 *             populated; Fonts / Audio are scaffolds.
 *   - Center: live preview player + a small project header (title + Export).
 *   - Right:  Text / Templates / Transitions / AI Audio tabs.
 *
 * The Text + Templates tabs both edit the same `style` value: Templates picks
 * a base preset, Text panel layers per-property overrides on top. The merged
 * style is what the preview and /api/render both consume.
 */

import { useEffect, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import { CaptionPreview } from "./CaptionPreview";
import { CaptionsList } from "./CaptionsList";
import { TemplatesPanel } from "./TemplatesPanel";
import { TextPanel } from "./TextPanel";
import { Timeline } from "./Timeline";
import {
  CAPTION_STYLES,
  applyStyleOverrides,
  type CaptionStyle,
  type CaptionStyleId,
  type CaptionStyleOverrides,
} from "@/lib/styles";
import type { ProjectRecord } from "@/lib/projects";
import type { WhisperWord } from "@/lib/whisper";
import type { UserFont } from "@/lib/userFonts";
import {
  whisperWordsToSrt,
  whisperWordsToVtt,
  downloadTextFile,
} from "@/lib/subtitles";

export type RightTab = "text" | "templates" | "transitions" | "audio";

interface Props {
  project: ProjectRecord;
  file: File;
  styleId: CaptionStyleId;
  /** Which template ID the Text panel is currently editing — same as
   *  `styleId` when no line is selected, or the selected line's
   *  per-line template (`lineStyles[key]`) when one is. Lets the
   *  TextPanel sliders show values relative to the right base
   *  preset, not always the project-wide one. */
  editingStyleId: CaptionStyleId;
  overrides: CaptionStyleOverrides;
  onOverridesChange: (next: CaptionStyleOverrides) => void;
  /** Live-editable words. Changes propagate up so debounced saves can
   *  push to Supabase from the page-level state. */
  words: WhisperWord[];
  onWordsChange: (next: WhisperWord[]) => void;
  onBack: () => void;
  onExport: () => void;
  exporting: boolean;
  exportDownloadUrl?: string;
  exportError?: string | null;
  /** Toggle for transparent (.webm + alpha) export. */
  transparent: boolean;
  onTransparentChange: (next: boolean) => void;
  /** User-uploaded fonts (with signed URLs). Show in TextPanel dropdown
   *  + inject as @font-face when picked. */
  userFonts: UserFont[];
  /** Called by TextPanel after a successful upload / delete so the page
   *  can refetch the list. */
  onUserFontsChanged: () => void | Promise<void>;
  /** Output canvas dimensions, derived from the dropped media's aspect
   *  ratio so reels stay vertical and YT clips stay horizontal. Forwarded
   *  to CaptionPreview so the Player + render canvas match. */
  canvasWidth: number;
  canvasHeight: number;
  /** Per-line entrance-animation overrides keyed by centisecond start.
   *  Edited from CaptionsList, applied by the composition. */
  lineAnimations: Record<string, string>;
  onLineAnimationsChange: (next: Record<string, string>) => void;
  /** Per-line template overrides keyed by centisecond start. Each
   *  value is a `CaptionStyleId`. Lines with an entry render with
   *  that template instead of the project-wide `styleId`. */
  lineStyles: Record<string, CaptionStyleId>;
  /** Per-line Text-panel overrides keyed by centisecond start. Lets
   *  one line's font / colour / position tweaks stay isolated from
   *  every other line — even ones that share the same template. */
  lineOverrides: Record<string, CaptionStyleOverrides>;
  /** Currently-selected line in the timeline (centisecond key). When
   *  set, picking a template via `onPickTemplate` only overrides
   *  that one line; otherwise the project-wide template changes. */
  selectedLineKey: string | null;
  onSelectLine: (key: string | null) => void;
  /** Selection-aware template picker — supplied by the parent so
   *  the same handler can switch between "global" and "single line"
   *  modes based on `selectedLineKey`. Replaces the inline
   *  `onPickTemplate` we used to compute inside this component. */
  onPickTemplate: (id: CaptionStyleId) => void;
  /** Clears the per-line template override for the selected line so
   *  it falls back to the global template. No-op when no selection. */
  onClearLineStyle: () => void;
  /** Per-word fontSize multipliers (centisecond keys → multiplier). */
  wordSizes: Record<string, number>;
  onWordSizesChange: (next: Record<string, number>) => void;
  /** User-forced line breaks — Set of word indexes after which the
   *  captions grouper must start a new line. Edited inline from the
   *  captions list (hover ⏎ between two words). */
  userBreaks: Set<number>;
  onUserBreaksChange: (next: Set<number>) => void;
  /** Kick off a fresh transcription pass on the same source file.
   *  Replaces the current transcript in place (destructive — any
   *  manual edits are lost). Optional: when absent, the button
   *  hides. */
  onRetranscribe?: () => void;
  retranscribing?: boolean;
  /** Caption IN / OUT trim points in seconds — words outside this
   *  range are dropped from the render + preview. Set/clear via the
   *  Timeline's Mark In / Mark Out buttons (I / O shortcuts). */
  captionInSec?: number | null;
  captionOutSec?: number | null;
  onCaptionRangeChange?: (
    inSec: number | null,
    outSec: number | null
  ) => void;
  /** Undo / Redo controls surfaced as toolbar buttons. Same handlers
   *  the Ctrl+Z / Ctrl+Y keyboard shortcuts already fire. The
   *  can* flags gate the enabled/disabled state so users see when
   *  there's nothing left to undo/redo. */
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

export function EditorView({
  project, file, styleId, editingStyleId,
  overrides, onOverridesChange,
  words, onWordsChange,
  onBack, onExport, exporting, exportDownloadUrl, exportError,
  onRetranscribe, retranscribing,
  captionInSec, captionOutSec, onCaptionRangeChange,
  onUndo, onRedo, canUndo, canRedo,
  transparent, onTransparentChange,
  userFonts, onUserFontsChanged,
  canvasWidth, canvasHeight,
  lineAnimations, onLineAnimationsChange,
  lineStyles, lineOverrides, selectedLineKey, onSelectLine, onPickTemplate, onClearLineStyle,
  wordSizes, onWordSizesChange,
  userBreaks, onUserBreaksChange,
}: Props) {
  // Single point that handles per-line variant edits. Setting a variant
  // adds/replaces the key; passing `null` removes it (resetting that
  // line back to the cyclic default).
  const handleLineAnimationChange = (key: string, variant: string | null) => {
    if (variant === null) {
      const next = { ...lineAnimations };
      delete next[key];
      onLineAnimationsChange(next);
    } else {
      onLineAnimationsChange({ ...lineAnimations, [key]: variant });
    }
  };
  const [rightTab, setRightTab] = useState<RightTab>("templates");
  const [leftTab, setLeftTab] = useState<"captions" | "fonts" | "audio">("captions");
  // Player ref shared between CaptionPreview (sets it) and Timeline
  // (reads currentFrame + seeks). Created once per editor session so
  // its identity stays stable across re-renders.
  const playerRef = useRef<PlayerRef>(null);

  // Drag-to-reposition mode: when on, the preview overlay captures
  // pointer events and updates horizontalPosition / verticalPosition
  // (per-line if a line is selected, otherwise global).
  const [dragModeActive, setDragModeActive] = useState(false);

  // ── Program zoom + hand tool ───────────────────────────────────────────
  // Lets the user zoom into the preview canvas (mouse wheel or +/- keys),
  // pan with the hand tool (spacebar+drag, or toolbar toggle), and snap
  // back to "fit to viewport" with one click. Useful on small laptop
  // screens or when fine-tuning a specific corner of the canvas.
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [handToolToggled, setHandToolToggled] = useState(false);
  const [handToolHeld, setHandToolHeld] = useState(false); // spacebar held
  const handToolActive = handToolToggled || handToolHeld;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 5;
  const ZOOM_STEP = 1.15;

  // Spacebar = temporary hand tool (industry-standard shortcut from
  // Photoshop / Figma / Premiere). Only when no input/textarea is focused
  // so it doesn't interfere with caption editing.
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setHandToolHeld(true);
      } else if ((e.key === "+" || e.key === "=") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP));
      } else if (e.key === "-" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP));
      } else if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setZoom(1);
        setPanX(0);
        setPanY(0);
      } else if ((e.key === "h" || e.key === "H") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // H = Hand tool (industry standard from Photoshop / Premiere).
        e.preventDefault();
        setHandToolToggled(true);
        setHandToolHeld(false);
        panRef.current = null;
      } else if ((e.key === "v" || e.key === "V") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // V = Selector / default cursor (mirror of Photoshop / Premiere).
        e.preventDefault();
        setHandToolToggled(false);
        setHandToolHeld(false);
        panRef.current = null;
      } else if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Tab = Play / pause via the Player ref. Prevented from bubbling
        // so it doesn't shift focus around the editor at the same time.
        e.preventDefault();
        const p = playerRef.current;
        if (p) {
          if (p.isPlaying()) p.pause();
          else p.play();
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setHandToolHeld(false);
    };
    // Safety net — if focus shifts while spacebar is held, the keyup
    // never fires inside this window. Clearing on blur prevents the
    // hand tool from getting stuck on after an alt-tab.
    const onBlur = () => setHandToolHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const handleZoomReset = () => {
    setZoom(1);
    setPanX(0);
    setPanY(0);
  };

  const handleZoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP));
  const handleZoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP));

  const handleWheelZoom = (e: React.WheelEvent<HTMLDivElement>) => {
    // Always zoom on wheel inside the preview area — no modifier needed.
    // The preview frame doesn't scroll, so capturing the wheel here is
    // intuitive (same UX as Premiere / Photoshop / Figma viewports).
    e.preventDefault();
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor)));
  };

  // Pan: while hand-tool is active, dragging the preview moves the
  // canvas inside its frame. Tracked with refs so the handlers stay
  // stable; React state is updated each move so the transform follows.
  const panRef = useRef<{ startX: number; startY: number; basePanX: number; basePanY: number } | null>(null);
  const handlePanDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!handToolActive) return;
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    panRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      basePanX: panX,
      basePanY: panY,
    };
  };
  const handlePanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!handToolActive || !panRef.current) return;
    const dx = e.clientX - panRef.current.startX;
    const dy = e.clientY - panRef.current.startY;
    setPanX(panRef.current.basePanX + dx);
    setPanY(panRef.current.basePanY + dy);
  };
  const handlePanUp = (e: React.PointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch { /* ok */ }
  };

  // Update horizontal/vertical position via the same `onOverridesChange`
  // the TextPanel uses — page.tsx routes this to the per-line overrides
  // map when `selectedLineKey` is set, or to the global overrides when
  // nothing's selected. Either way the next render reflects the drag.
  const handleCaptionDrag = (x: number, y: number) => {
    onOverridesChange({
      ...overrides,
      horizontalPosition: x,
      verticalPosition: y,
    });
  };

  const baseStyle = CAPTION_STYLES[styleId];
  const computedStyle: CaptionStyle = applyStyleOverrides(baseStyle, overrides);
  // The selection-aware template picker lives in page.tsx now and
  // arrives through props (`onPickTemplate`). The old local picker
  // here was unaware of `selectedLineKey`, so it always fell back to
  // changing the project-wide style.

  // Build the per-line FULL style map for the preview (same shape we
  // send to /api/render). A line is "independent" when it has either
  // a per-line template OR per-line text overrides — both cases need
  // a separate computed style so a Text-panel slider never bleeds
  // across lines. Each independent line's style merges its OWN
  // template (or the global template, when no per-line template is
  // set) with its OWN overrides only.
  const computedLineStyles: Record<string, CaptionStyle> = {};
  const independentKeys = new Set<string>([
    ...Object.keys(lineStyles),
    ...Object.keys(lineOverrides),
  ]);
  for (const k of independentKeys) {
    const sid = (lineStyles[k] ?? styleId) as CaptionStyleId;
    const preset = CAPTION_STYLES[sid];
    if (preset) {
      // Per-line styled lines INHERIT the global overrides (font,
      // colour, position…) first, then layer their own overrides on
      // top. Preview must mirror what onRender / api/render produces.
      computedLineStyles[k] = applyStyleOverrides(preset, {
        ...overrides,
        ...(lineOverrides[k] ?? {}),
      });
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] w-full">
      {/* Left vertical tab rail */}
      <div className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--bg-sidebar)] py-3">
        <LeftTab id="captions" active={leftTab === "captions"} onClick={() => setLeftTab("captions")} icon="caption" label="Captions" />
        <LeftTab id="fonts"    active={leftTab === "fonts"}    onClick={() => setLeftTab("fonts")}    icon="font"    label="Fonts" />
        <LeftTab id="audio"    active={leftTab === "audio"}    onClick={() => setLeftTab("audio")}    icon="audio"   label="Audio" badge="Soon" />
      </div>

      {/* Captions panel (changes with leftTab) — narrower on smaller
          windows so the editor remains usable without maximizing.
          Tailwind's responsive prefixes pick the bigger width once the
          viewport actually has room. */}
      <div className="flex w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-sidebar)] xl:w-72 2xl:w-80">
        {leftTab === "captions" && (
          <CaptionsList
            words={words}
            onWordsChange={onWordsChange}
            lineAnimations={lineAnimations}
            onLineAnimationChange={handleLineAnimationChange}
            wordSizes={wordSizes}
            onWordSizesChange={onWordSizesChange}
            userBreaks={userBreaks}
            onUserBreaksChange={onUserBreaksChange}
            playerRef={playerRef}
          />
        )}
        {leftTab === "fonts" && (
          <Placeholder title="Fonts" hint="Font browser & custom fonts arrive in Phase 3b." />
        )}
        {leftTab === "audio" && (
          <Placeholder title="Audio" hint="Voice cloning + AI dub coming soon." />
        )}
      </div>

      {/* Center: project header + player.
          `min-w-0` is critical here — flex items default to
          `min-width: auto`, which means the wide Timeline strip
          inside would push this column wider than its share of
          the parent flex layout, stretching the whole editor.
          With `min-w-0` the column stays at its flex-allocated
          width and the Timeline's internal `overflow-x-auto`
          actually kicks in, giving Premiere-style horizontal
          scroll INSIDE the panel instead of growing it. */}
      <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-3">
          <div className="flex items-center gap-2">
            {/* Home — returns to the recent-videos / upload screen so
                the user can pick a different existing project or
                start fresh. Both Home and "+ New File" call the same
                handler (onBack flips status → idle); the labels just
                surface intent more clearly than a back arrow. */}
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-xs font-medium text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition"
              aria-label="Back to home"
              title="Back to home — see Recent Videos"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                <path d="M3 12l9-9 9 9M5 10v10h14V10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Home
            </button>
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 rounded-md border border-[var(--accent)] bg-[var(--accent-bg)] px-3 py-2 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/20 transition"
              aria-label="Start a new file"
              title="Drop a new video / audio file"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3.5 w-3.5">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
              New File
            </button>
            {/* Undo / Redo — same handlers Ctrl+Z / Ctrl+Y already
                fire. Buttons are enabled only when the corresponding
                stack has entries so users see at a glance when
                there's nothing left to walk back or forward. */}
            {onUndo && (
              <>
                <div className="h-6 w-px bg-[var(--border)] mx-1" />
                <button
                  type="button"
                  onClick={onUndo}
                  disabled={!canUndo}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--text-muted)]"
                  title={canUndo ? "Undo (Ctrl / Cmd + Z)" : "Nothing to undo"}
                  aria-label="Undo"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="M3 7v6h6" />
                    <path d="M3 13a9 9 0 1 0 3-6.7L3 9" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={onRedo}
                  disabled={!canRedo}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--border)] disabled:hover:text-[var(--text-muted)]"
                  title={canRedo ? "Redo (Ctrl / Cmd + Shift + Z, or Ctrl + Y)" : "Nothing to redo"}
                  aria-label="Redo"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="M21 7v6h-6" />
                    <path d="M21 13a9 9 0 1 1-3-6.7L21 9" />
                  </svg>
                </button>
              </>
            )}
            <div className="h-6 w-px bg-[var(--border)] mx-1" />
            <div>
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold">{project.title}</div>
                {project.provider && (
                  <span
                    className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--text-muted)]"
                    title={`Transcribed via ${project.provider}`}
                  >
                    via {providerLabel(project.provider)}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">
                {project.whisper.words.length} words · {project.whisper.duration.toFixed(1)}s · {project.spokenLanguageLabel} ({project.writingScriptLabel})
              </div>
            </div>
            {/* Re-transcribe — throws away current transcript + edits
                and runs the STT pipeline again on the same source
                file. Useful when the first pass had wrong words or the
                user wants to try a different accuracy tier. Confirms
                before firing (destructive). */}
            {onRetranscribe && (
              <button
                type="button"
                onClick={() => {
                  const ok = window.confirm(
                    "Re-transcribe this file? Your caption edits will be replaced with a fresh transcription."
                  );
                  if (ok) onRetranscribe();
                }}
                disabled={retranscribing || exporting}
                className="ml-2 flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11px] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50 disabled:cursor-not-allowed"
                title="Re-run transcription on the same source file (replaces current transcript)"
              >
                {retranscribing ? (
                  <>
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Re-transcribing…
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10" />
                      <polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    Re-transcribe
                  </>
                )}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Transparent export toggle — flips the renderer to VP9/.webm
                with a real alpha channel so the file drops cleanly onto
                other footage in any editor. */}
            <label
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-[11px] cursor-pointer transition ${
                transparent
                  ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
              title="Export with a transparent background (WebM + alpha)"
            >
              <input
                type="checkbox"
                checked={transparent}
                onChange={(e) => onTransparentChange(e.target.checked)}
                disabled={exporting}
                className="h-3 w-3 accent-[var(--accent)]"
              />
              Transparent
            </label>

            {exportDownloadUrl && (
              <a
                href={exportDownloadUrl}
                download={`captora-${styleId}-${project.title}.${transparent ? "mov" : "mp4"}`}
                className="rounded-md border border-[var(--accent)] bg-[var(--accent-bg)] px-3 py-2 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/20"
              >
                ↓ Download
              </a>
            )}
            {/* Subtitle sidecar downloads — SRT for YouTube/Instagram/
                traditional players, VTT for HTML5 <track>. Available
                anytime, don't need a render first — captions come
                straight from the edited word timings. Sits behind a
                tiny "Subtitles" dropdown so it doesn't crowd the
                header for users who never touch them. */}
            <SubtitlesDropdown
              words={words}
              userBreaks={userBreaks}
              projectTitle={project.title}
            />
            <button
              type="button"
              onClick={onExport}
              disabled={exporting}
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {exporting ? "Rendering…" : "Export"}
            </button>
          </div>
        </div>

        <div
          className="flex flex-1 items-center justify-center overflow-hidden p-8"
          onWheel={handleWheelZoom}
          onPointerDown={handlePanDown}
          onPointerMove={handlePanMove}
          onPointerUp={handlePanUp}
          onPointerCancel={handlePanUp}
          style={{
            cursor: handToolActive
              ? panRef.current
                ? "grabbing"
                : "grab"
              : undefined,
          }}
        >
          {/* Premiere-style responsive sizing — the preview shrinks WITH
              the viewport instead of fixing a 320 / 405-px upper bound.
              `aspectRatio` locks the canvas shape; CSS picks the larger
              valid dimension under the viewport's available space.
              Result: shrinking the window shrinks the program preview;
              you never need to scroll past it to reach controls. */}
          <div
            className="relative mx-auto"
            style={{
              width: "min(100%, calc((100vh - 220px) * " +
                (canvasWidth / canvasHeight) + "))",
              aspectRatio: `${canvasWidth} / ${canvasHeight}`,
              transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
              transformOrigin: "center center",
              transition: panRef.current ? "none" : "transform 80ms ease-out",
              // While in hand-tool mode, swallow pointer-down on the
              // child so the pan handler on the parent fires (otherwise
              // Player's clickToPlay would intercept).
              pointerEvents: handToolActive ? "none" : "auto",
            }}
          >
            <CaptionPreview
              file={file}
              ext={project.ext}
              style={styleId}
              computedStyle={computedStyle}
              // Apply IN/OUT trim to the preview so what the user sees
              // is what the exported MP4 will contain. Same filter the
              // render request uses in page.tsx.
              words={words.filter((w) => {
                if (captionInSec != null && w.start < captionInSec) return false;
                if (captionOutSec != null && w.start > captionOutSec) return false;
                return true;
              })}
              durationSec={project.whisper.duration}
              userFonts={userFonts}
              width={canvasWidth}
              height={canvasHeight}
              lineAnimations={lineAnimations}
              lineStyles={computedLineStyles}
              wordSizes={wordSizes}
              userBreaks={Array.from(userBreaks)}
              playerRef={playerRef}
              dragModeActive={dragModeActive}
              onPositionChange={handleCaptionDrag}
            />
          </div>

          {/* Preview toolbar — Move-caption + Program zoom controls.
              Sits below the preview so the user can flip into drag mode
              without leaving the editor center column. */}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            {/* Zoom controls */}
            <div className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-1">
              <button
                type="button"
                onClick={handleZoomOut}
                disabled={zoom <= ZOOM_MIN + 0.001}
                className="flex h-6 w-6 items-center justify-center rounded text-sm text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-30"
                title="Zoom out (Ctrl/Cmd + −)"
              >
                −
              </button>
              <button
                type="button"
                onClick={handleZoomReset}
                className="min-w-[48px] rounded px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                title="Reset to fit (Ctrl/Cmd + 0)"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={handleZoomIn}
                disabled={zoom >= ZOOM_MAX - 0.001}
                className="flex h-6 w-6 items-center justify-center rounded text-sm text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-30"
                title="Zoom in (Ctrl/Cmd + +)"
              >
                +
              </button>
              <div className="mx-1 h-4 w-px bg-[var(--border)]" />
              <button
                type="button"
                onClick={() => {
                  // Toggling clears the spacebar-held flag too, so a stuck
                  // keyup (window blur during spacebar) doesn't leave the
                  // hand tool permanently on.
                  setHandToolToggled((v) => !v);
                  setHandToolHeld(false);
                  panRef.current = null;
                }}
                className={`flex h-6 w-6 items-center justify-center rounded text-sm transition ${
                  handToolToggled
                    ? "bg-[var(--accent)] text-black"
                    : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                }`}
                title={
                  handToolToggled
                    ? "Hand tool ON — click again to disable"
                    : "Hand tool — drag to pan (or hold Spacebar)"
                }
              >
                ✋
              </button>
              <button
                type="button"
                onClick={handleZoomReset}
                className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                title="Fit to viewport (Ctrl/Cmd + 0)"
              >
                Fit
              </button>
            </div>
            {/* Move-caption toggle (existing). */}
            <button
              type="button"
              onClick={() => setDragModeActive((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] uppercase tracking-wide transition ${
                dragModeActive
                  ? "border-[var(--accent)] bg-[var(--accent)] text-black"
                  : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
              }`}
              title={
                selectedLineKey
                  ? "Drag the selected line's caption"
                  : "Drag the global caption position"
              }
            >
              {dragModeActive ? "✕ Exit Move Mode" : "✥ Move Caption"}
            </button>
            {dragModeActive && (
              <span className="text-[10px] text-[var(--text-muted)]">
                {selectedLineKey
                  ? "Repositioning selected line only"
                  : "Repositioning all captions globally"}
              </span>
            )}
          </div>
        </div>

        {/* Timeline strip — playhead + word chips. Lives at the bottom
            of the editor's center column so it sits below the preview
            but above the export-error/render-status footers. */}
        <Timeline
          playerRef={playerRef}
          words={words}
          durationSec={project.whisper.duration}
          onWordsChange={onWordsChange}
          file={file}
          selectedLineKey={selectedLineKey}
          onSelectLine={onSelectLine}
          userBreaks={userBreaks}
          onUserBreaksChange={onUserBreaksChange}
          captionInSec={captionInSec}
          captionOutSec={captionOutSec}
          onCaptionRangeChange={onCaptionRangeChange}
        />

        {exportError && (
          <div className="border-t border-rose-700/50 bg-rose-950/40 px-6 py-2 text-xs text-rose-300">
            {exportError}
          </div>
        )}
      </div>

      {/* Right tabs — same responsive scaling pattern as the left
          captions panel. Default 280px works on 1366×768 laptops; the
          Templates / Text panels expand on bigger screens for less
          chip wrapping. */}
      <div className="flex w-[280px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-sidebar)] xl:w-[320px] 2xl:w-[360px]">
        <div className="flex border-b border-[var(--border)]">
          <RightTabButton active={rightTab === "text"}        label="Text"        onClick={() => setRightTab("text")} />
          <RightTabButton active={rightTab === "templates"}   label="Templates"   onClick={() => setRightTab("templates")} />
          <RightTabButton active={rightTab === "transitions"} label="Transitions" onClick={() => setRightTab("transitions")} />
          <RightTabButton active={rightTab === "audio"}       label="AI Audio"    onClick={() => setRightTab("audio")} />
        </div>

        <div className="flex-1 overflow-hidden">
          {rightTab === "text" && (
            <TextPanel
              // `editingStyleId` resolves to the line's per-line
              // template if a line is selected, else the project-
              // wide template. The TextPanel's sliders compute their
              // displayed values relative to whatever base is here,
              // so reading "Position Y: 60%" actually corresponds to
              // the preset the user is currently editing.
              base={CAPTION_STYLES[editingStyleId]}
              overrides={overrides}
              onChange={onOverridesChange}
              onReset={() => onOverridesChange({})}
              userFonts={userFonts}
              onUserFontsChanged={onUserFontsChanged}
            />
          )}
          {rightTab === "templates" && (
            <TemplatesPanel
              selected={styleId}
              onSelect={onPickTemplate}
              selectedLineKey={selectedLineKey}
              lineStyles={lineStyles}
              onClearLineStyle={onClearLineStyle}
              onClearSelection={() => onSelectLine(null)}
            />
          )}
          {rightTab === "transitions" && (
            <Placeholder title="Transitions" hint="Per-word entrance / exit animation library — Phase 3b." />
          )}
          {rightTab === "audio" && (
            <Placeholder title="AI Audio" hint="Voice cloning + AI music — Phase 3b." />
          )}
        </div>
      </div>
    </div>
  );
}

function LeftTab({ active, onClick, icon, label, badge }: {
  id: string; active: boolean; onClick: () => void; icon: string; label: string; badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex w-14 flex-col items-center gap-1 rounded-md py-2 text-[10px] font-medium transition ${
        active
          ? "bg-[var(--accent-bg)] text-[var(--accent)]"
          : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
      }`}
    >
      <LeftTabIcon name={icon} />
      <span>{label}</span>
      {badge && (
        <span className="absolute -top-0.5 -right-0.5 rounded-full bg-rose-500 px-1 py-px text-[8px] font-bold uppercase text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

function LeftTabIcon({ name }: { name: string }) {
  const cls = "h-5 w-5";
  switch (name) {
    case "caption":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 10h4M7 14h6M14 10h3M14 14h3" strokeLinecap="round" />
        </svg>
      );
    case "font":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls}>
          <path d="M5 7V5h14v2M9 19h6M12 5v14" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "audio":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={cls}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      );
    default:
      return null;
  }
}

function RightTabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-2 py-3 text-xs font-medium transition ${
        active
          ? "border-b-2 border-[var(--accent)] text-[var(--text)]"
          : "border-b-2 border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
      }`}
    >
      {label}
    </button>
  );
}

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-sm font-semibold text-[var(--text-muted)]">{title}</div>
      <div className="text-xs text-[var(--text-muted)]">{hint}</div>
    </div>
  );
}

/**
 * Small "Subtitles ▾" dropdown in the editor header. Reveals SRT / VTT
 * download options built from the current edited word timings — no
 * render required, downloads instantly.
 *
 * Kept as a tight two-item menu so it doesn't compete with the primary
 * Export button for attention; users who don't need subtitle sidecars
 * never open it.
 */
function SubtitlesDropdown({
  words,
  userBreaks,
  projectTitle,
}: {
  words: WhisperWord[];
  userBreaks: Set<number>;
  projectTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click — small custom menu, not worth wiring a
  // full <Popover> abstraction for two links.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const safeTitle = (projectTitle || "captions").replace(/[<>:"|?*\\/]+/g, "");

  const handleSrt = () => {
    const srt = whisperWordsToSrt(words, { userBreaks });
    downloadTextFile(`${safeTitle}.srt`, srt, "application/x-subrip;charset=utf-8");
    setOpen(false);
  };
  const handleVtt = () => {
    const vtt = whisperWordsToVtt(words, { userBreaks });
    downloadTextFile(`${safeTitle}.vtt`, vtt, "text/vtt;charset=utf-8");
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={words.length === 0}
        className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-2 text-[11px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50 disabled:cursor-not-allowed"
        title="Download SRT or VTT subtitle sidecar"
      >
        Subtitles
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="6 9 12 15 18 9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 flex w-40 flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] shadow-lg">
          <button
            type="button"
            onClick={handleSrt}
            className="flex flex-col items-start px-3 py-2 text-left hover:bg-[var(--bg-hover)]"
          >
            <span className="text-xs font-semibold text-[var(--text)]">Download .srt</span>
            <span className="text-[10px] text-[var(--text-muted)]">YouTube, Instagram, VLC</span>
          </button>
          <button
            type="button"
            onClick={handleVtt}
            className="flex flex-col items-start border-t border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--bg-hover)]"
          >
            <span className="text-xs font-semibold text-[var(--text)]">Download .vtt</span>
            <span className="text-[10px] text-[var(--text-muted)]">HTML5 &lt;track&gt;, web players</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Friendly label for the transcription engine that produced this project. */
function providerLabel(provider: string): string {
  switch (provider) {
    case "faster-whisper-gpu": return "GPU";
    case "sarvam":             return "Sarvam";
    case "groq":               return "Groq";
    case "local-whisper":      return "Whisper";
    default:                   return provider;
  }
}
