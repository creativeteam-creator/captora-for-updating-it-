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

import { useRef, useState } from "react";
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
}

export function EditorView({
  project, file, styleId, editingStyleId,
  overrides, onOverridesChange,
  words, onWordsChange,
  onBack, onExport, exporting, exportDownloadUrl, exportError,
  transparent, onTransparentChange,
  userFonts, onUserFontsChanged,
  canvasWidth, canvasHeight,
  lineAnimations, onLineAnimationsChange,
  lineStyles, lineOverrides, selectedLineKey, onSelectLine, onPickTemplate, onClearLineStyle,
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
      computedLineStyles[k] = applyStyleOverrides(preset, lineOverrides[k] ?? {});
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
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              aria-label="Back to home"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
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

        <div className="flex flex-1 items-center justify-center overflow-hidden p-8">
          {/* Sized so the long edge fits a sensible viewport. Vertical
              reel → narrow column (320px wide); horizontal YT → wide
              row (~720px wide); square → ~480px. The Player itself
              fills 100% of this container and locks its aspect ratio. */}
          <div
            className="w-full"
            style={{
              maxWidth:
                canvasHeight >= canvasWidth
                  ? "320px"
                  : `${Math.round((canvasWidth / canvasHeight) * 405)}px`,
              maxHeight: "calc(100vh - 200px)",
            }}
          >
            <CaptionPreview
              file={file}
              ext={project.ext}
              style={styleId}
              computedStyle={computedStyle}
              words={words}
              durationSec={project.whisper.duration}
              userFonts={userFonts}
              width={canvasWidth}
              height={canvasHeight}
              lineAnimations={lineAnimations}
              lineStyles={computedLineStyles}
              playerRef={playerRef}
            />
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
