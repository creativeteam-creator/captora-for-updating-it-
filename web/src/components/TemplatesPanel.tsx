"use client";

/**
 * Right-panel "Templates" tab — Captora's preset gallery. Each card renders
 * a small visual preview that's actually driven by the same `CaptionStyle`
 * fields the renderer reads (textCase, glowOnActive, highlightGradient,
 * boxBackground), so the card faithfully represents the final output.
 *
 * Sub-tabs (Built-in / My Presets) and Save Preset are scaffolded; My
 * Presets stays empty until persistence lands.
 */

import { useState } from "react";
import {
  CAPTION_STYLES,
  rgbToCss,
  type CaptionStyle,
  type CaptionStyleId,
} from "@/lib/styles";

interface Props {
  selected: CaptionStyleId;
  onSelect: (id: CaptionStyleId) => void;
  /** Selection-mode state. When `selectedLineKey` is set, the panel
   *  shows an "applying to line" banner and the next template pick
   *  goes via `onSelect` to that line only (parent's `onPickTemplate`
   *  routes to per-line vs global based on this flag). */
  selectedLineKey?: string | null;
  /** Per-line override map — used to surface which template a line
   *  currently has when it's selected. */
  lineStyles?: Record<string, CaptionStyleId>;
  /** Clears the per-line override for the selected line. Shown as a
   *  "Reset to global" button in the banner. */
  onClearLineStyle?: () => void;
  /** Cancels the selection without changing any styles. */
  onClearSelection?: () => void;
}

type SubTab = "builtin" | "presets";

export function TemplatesPanel({
  selected,
  onSelect,
  selectedLineKey,
  lineStyles,
  onClearLineStyle,
  onClearSelection,
}: Props) {
  const [tab, setTab] = useState<SubTab>("builtin");
  const [filter, setFilter] = useState("");

  const styles = Object.values(CAPTION_STYLES).filter((s) =>
    s.label.toLowerCase().includes(filter.toLowerCase())
  );

  // The currently-selected line's per-line override (if any), so the
  // matching template card can show a different "ACTIVE FOR THIS LINE"
  // chip vs the project-wide one.
  const lineSelectedStyleId =
    selectedLineKey && lineStyles ? lineStyles[selectedLineKey] : undefined;
  const effectiveSelected = lineSelectedStyleId ?? selected;

  return (
    <div className="flex h-full flex-col">
      {/* Per-line selection banner — visible only when a line chip in
          the timeline is selected. Clicking a template while this is
          shown applies it to that ONE line. Two escape hatches:
          "Reset to global" wipes the per-line override; "Cancel
          selection" clears the selection without touching styles. */}
      {selectedLineKey && (
        <div className="flex items-center gap-2 border-b border-amber-300/40 bg-amber-300/10 px-3 py-2 text-[11px] text-amber-100">
          <span className="rounded-full bg-amber-300 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-950">
            Line
          </span>
          <span className="flex-1 truncate">
            Template will apply to the selected line only.
          </span>
          {lineSelectedStyleId && (
            <button
              type="button"
              onClick={onClearLineStyle}
              className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-amber-300/20"
              title="Remove this line's per-line template override"
            >
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={onClearSelection}
            className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-amber-300/20"
            title="Clear selection — next pick changes the project-wide template"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="flex gap-1 border-b border-[var(--border)] p-3">
        <button
          type="button"
          onClick={() => setTab("builtin")}
          className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition ${
            tab === "builtin"
              ? "bg-[var(--bg-hover)] text-[var(--text)]"
              : "text-[var(--text-muted)] hover:text-[var(--text)]"
          }`}
        >
          Built-in Templates
        </button>
        <button
          type="button"
          onClick={() => setTab("presets")}
          className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition ${
            tab === "presets"
              ? "bg-[var(--bg-hover)] text-[var(--text)]"
              : "text-[var(--text-muted)] hover:text-[var(--text)]"
          }`}
        >
          My Presets
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--border)] p-3">
        <div className="relative flex-1">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.5-4.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a template..."
            className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] pl-8 pr-2 text-xs placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" strokeLinejoin="round" />
            <path d="M17 21v-8H7v8M7 3v5h8" strokeLinejoin="round" />
          </svg>
          Save Preset
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {tab === "builtin" ? (
          styles.length === 0 ? (
            <div className="py-6 text-center text-xs text-[var(--text-muted)]">
              No templates match.
            </div>
          ) : (
            styles.map((s) => (
              <TemplateCard
                key={s.id}
                style={s}
                selected={effectiveSelected === s.id}
                onClick={() => onSelect(s.id)}
              />
            ))
          )
        ) : (
          <div className="py-6 text-center text-xs text-[var(--text-muted)]">
            No saved presets yet. Tweak a template and click Save Preset.
          </div>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  style: CaptionStyle;
  selected: boolean;
  onClick: () => void;
}

function TemplateCard({ style, selected, onClick }: CardProps) {
  // Tags inferred from the same fields the renderer uses, so the card stays
  // honest as we add templates.
  const tags: string[] = [];
  if (style.strokeWidth >= 4) tags.push("Bold");
  if (style.shadowOpacity >= 0.5) tags.push("Shadow");
  if (style.glowOnActive) tags.push("Glow");
  if (style.highlightGradient) tags.push("Gradient");
  if (style.boxBackground) tags.push("Pill");
  if (style.perWordChip) tags.push("Chips");
  // Per-word entrance — distinct chip so users can scan the panel for
  // kinetic-typography templates at a glance. "Mix" tag when the
  // template cycles multiple variants (different animation per word).
  if (style.wordEntrance) {
    if (Array.isArray(style.wordEntrance) && style.wordEntrance.length > 1) {
      tags.push("Kinetic Mix");
    } else {
      tags.push("Kinetic");
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group block w-full overflow-hidden rounded-lg border text-left transition ${
        selected
          ? "border-[var(--accent)] bg-[var(--accent-bg)]"
          : "border-[var(--border)] bg-[var(--bg-elevated)] hover:border-[var(--accent)]/60"
      }`}
    >
      <div className="flex items-center justify-between px-3 pt-2.5">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold text-[var(--text)]">{style.label}</div>
          {style.isNew && (
            <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
              New
            </span>
          )}
        </div>
        {selected ? (
          <span className="rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[9px] font-bold text-white">
            ACTIVE
          </span>
        ) : (
          <PalettePreview style={style} />
        )}
      </div>

      <div className="flex h-28 items-center justify-center px-3 py-3">
        <PreviewPhrase style={style} />
      </div>

      {tags.length > 0 && (
        <div className="flex items-center gap-1.5 border-t border-[var(--border)] px-3 py-2">
          {tags.map((t) => (
            <span
              key={t}
              className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--text-muted)]"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

/** Tiny three-dot palette icon shown on the right of unselected cards. */
function PalettePreview({ style }: { style: CaptionStyle }) {
  return (
    <div className="flex items-center gap-1">
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: rgbToCss(style.highlightColor) }}
      />
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-[var(--text-muted)]">
        <circle cx="12" cy="12" r="9" />
        <circle cx="9" cy="9" r="1" fill="currentColor" />
        <circle cx="15" cy="9" r="1" fill="currentColor" />
        <circle cx="9" cy="14" r="1" fill="currentColor" />
        <circle cx="15" cy="14" r="1" fill="currentColor" />
      </svg>
    </div>
  );
}

/**
 * Mini "Hello and WELCOME to Captora." preview that mimics the renderer's
 * actual choices — uppercase if the style says so, glow + gradient + box
 * applied per the template fields.
 */
function PreviewPhrase({ style }: { style: CaptionStyle }) {
  const isUpper = style.textCase === "upper";
  const baseColor = rgbToCss(style.baseColor);
  const highlightColor = rgbToCss(style.highlightColor);
  const inactiveBoxColor = style.boxInactiveColor ? rgbToCss(style.boxInactiveColor) : baseColor;

  // Box (pill) variant — Ali Abdaal style.
  if (style.boxBackground) {
    const before = "The quick";
    const after = "brown fox";
    return (
      <div
        style={{
          fontFamily: style.fontFamily,
          backgroundColor: rgbToCss(style.boxBackground.color),
          padding: "8px 14px",
          borderRadius: 12,
          boxShadow: `0 4px 18px rgba(0, 0, 0, ${style.shadowOpacity})`,
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: "0.01em",
          display: "inline-flex",
          gap: "0.35em",
          alignItems: "baseline",
          textTransform: isUpper ? "uppercase" : "none",
        }}
      >
        <span style={{ color: highlightColor }}>{before}</span>
        <span style={{ color: inactiveBoxColor }}>{after}</span>
      </div>
    );
  }

  // Standard 3-line phrase preview. Highlight word ("WELCOME") gets the
  // template's full active-word treatment.
  const lineSmallStyle: React.CSSProperties = {
    color: baseColor,
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1.05,
    WebkitTextStroke: style.strokeWidth >= 3 ? `1px black` : "none",
    textShadow: `0 2px 6px rgba(0,0,0,${style.shadowOpacity})`,
  };

  // Active-word styling: gradient OR solid highlight, optional glow.
  const useGradient = !!style.highlightGradient;
  const gradientFrom = style.highlightGradient ? rgbToCss(style.highlightGradient.from) : highlightColor;
  const gradientTo   = style.highlightGradient ? rgbToCss(style.highlightGradient.to)   : highlightColor;

  const highlightStyle: React.CSSProperties = {
    fontSize: 26,
    fontWeight: 900,
    lineHeight: 1.05,
    letterSpacing: "0.01em",
    WebkitTextStroke: style.strokeWidth >= 3 ? `1.5px black` : "none",
  };
  if (useGradient) {
    highlightStyle.background = `linear-gradient(180deg, ${gradientFrom} 0%, ${gradientTo} 100%)`;
    highlightStyle.WebkitBackgroundClip = "text";
    highlightStyle.WebkitTextFillColor = "transparent";
    highlightStyle.filter = "drop-shadow(0 1px 0 black)";
  } else {
    highlightStyle.color = highlightColor;
    if (style.glowOnActive) {
      highlightStyle.textShadow = `0 0 12px ${highlightColor}, 0 0 4px ${highlightColor}`;
    }
  }

  return (
    <div
      style={{
        fontFamily: style.fontFamily,
        textAlign: "center",
        textTransform: isUpper ? "uppercase" : "none",
      }}
    >
      <div style={lineSmallStyle}>Hello and</div>
      <div style={highlightStyle}>WELCOME</div>
      <div style={lineSmallStyle}>to Captora.</div>
    </div>
  );
}
