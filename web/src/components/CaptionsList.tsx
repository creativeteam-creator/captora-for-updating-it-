"use client";

/**
 * Left-panel captions list — Captora style. One row per "line" (phrase),
 * with the keyword (longest word) chip-highlighted in the accent colour.
 *
 * Words are click-to-edit:
 *   - Click any word → it becomes a text input sized to its content
 *   - Enter / blur saves the new text → propagates to `onWordsChange`
 *   - Escape cancels and reverts
 *
 * Empty edits delete the word entirely. Multi-word inputs are handled by
 * splitting on whitespace and inserting the extras in place, sharing the
 * original timestamp evenly so the captions stay roughly synced.
 */

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { groupWordsIntoLines, pickKeywordIndex } from "@/lib/captions";
import type { WhisperWord } from "@/lib/whisper";
import { ENTRANCE_VARIANT_CYCLE, type EntranceVariant } from "@captora/remotion";

/**
 * Silently save a word correction to the backend glossary.
 * Called when the user edits a caption word — no UI blocking, no error toast.
 */
async function saveGlossaryEntry(from: string, to: string): Promise<void> {
  try {
    await fetch("/api/glossary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  } catch {
    // Network errors are silently ignored — glossary save is best-effort
  }
}

/** Centisecond key — must match the renderer's lookup in CaptionsTimeline. */
function lineKey(startSec: number): string {
  return String((startSec * 100) | 0);
}

const VALID_VARIANTS = new Set<string>(ENTRANCE_VARIANT_CYCLE);

/**
 * Find a per-line override for `startSec` with the same fuzzy ±500ms
 * tolerance the renderer uses. Keeps editor-button state in sync after
 * small timestamp drifts (re-transcribe, multi-word splits) instead of
 * showing the line as un-animated when its override is just slightly
 * mis-keyed.
 */
function resolveOverrideKey(
  startSec: number,
  table: Record<string, string> | undefined
): { key: string; variant: EntranceVariant } | null {
  if (!table) return null;
  const exactKey = lineKey(startSec);
  const exact = table[exactKey];
  if (exact && VALID_VARIANTS.has(exact)) {
    return { key: exactKey, variant: exact as EntranceVariant };
  }
  const target = Math.round(startSec * 100);
  let best: { delta: number; key: string; variant: EntranceVariant } | null = null;
  for (const [k, v] of Object.entries(table)) {
    if (!VALID_VARIANTS.has(v)) continue;
    const delta = Math.abs(Number(k) - target);
    if (delta > 50) continue;
    if (!best || delta < best.delta) {
      best = { delta, key: k, variant: v as EntranceVariant };
    }
  }
  return best ? { key: best.key, variant: best.variant } : null;
}

const VARIANT_LABELS: Record<EntranceVariant, string> = {
  pop: "Pop",
  fade: "Fade",
  "slide-up": "Slide Up",
  "zoom-in": "Zoom In",
  "slide-down": "Slide Down",
  "tilt-in": "Tilt In",
};

interface Props {
  words: WhisperWord[];
  onWordsChange?: (next: WhisperWord[]) => void;
  /** Per-line entrance overrides (centisecond key → variant). Persisted
   *  on the project so picks survive page reloads. */
  lineAnimations?: Record<string, string>;
  onLineAnimationChange?: (key: string, variant: EntranceVariant | null) => void;
  /** Per-word fontSize multipliers keyed by `(word.start * 100) | 0`
   *  centiseconds. 1.0 = default, 1.5 = 150%. */
  wordSizes?: Record<string, number>;
  onWordSizesChange?: (next: Record<string, number>) => void;
}

export function CaptionsList({
  words, onWordsChange, lineAnimations, onLineAnimationChange,
  wordSizes, onWordSizesChange,
}: Props) {
  const lines = useMemo(() => groupWordsIntoLines(words), [words]);
  // Absolute index of the word currently in edit mode, or null when none.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Which line currently has its animation popover open (null = none).
  const [animPopoverLineKey, setAnimPopoverLineKey] = useState<string | null>(null);

  // Auto-focus when entering edit mode, with the cursor parked at the
  // end of the word — NOT a select-all. Select-all caused the most
  // common edit ("transplantar" → "transplant", "tritament" → "treatment")
  // to nuke the whole word the moment the user pressed any key, because
  // the first keystroke replaced the highlighted selection instead of
  // editing in place. Cursor-at-end is the same pattern Notion / Figma
  // use for inline rename and matches the user's expectation.
  useEffect(() => {
    if (editingIndex !== null && inputRef.current) {
      const el = inputRef.current;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, [editingIndex]);

  const beginEdit = (absoluteIdx: number, currentText: string) => {
    if (!onWordsChange) return;
    setEditingIndex(absoluteIdx);
    setEditingValue(currentText);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditingValue("");
  };

  const commitEdit = () => {
    if (editingIndex === null) return;
    if (!onWordsChange) {
      cancelEdit();
      return;
    }
    const trimmed = editingValue.trim();
    const original = words[editingIndex];
    const next = [...words];

    if (trimmed.length === 0) {
      // Empty input → drop the word.
      next.splice(editingIndex, 1);
    } else {
      // Split on whitespace — typing "naam tarun" replaces one word with two.
      const tokens = trimmed.split(/\s+/);
      const span = Math.max(0.05, original.end - original.start);
      const per = span / tokens.length;
      const replacement: WhisperWord[] = tokens.map((tok, i) => ({
        word: tok,
        start: original.start + i * per,
        end: original.start + (i + 1) * per,
      }));
      next.splice(editingIndex, 1, ...replacement);

      // ── Auto-save to backend glossary ─────────────────────────────────
      // If the user changed the word (not just whitespace-trimmed), save
      // original → corrected so future transcriptions apply it automatically.
      const firstToken = tokens[0];
      if (
        tokens.length === 1 &&
        firstToken.toLowerCase() !== original.word.toLowerCase()
      ) {
        // Single-word replacement — save as glossary entry
        void saveGlossaryEntry(original.word, firstToken);
      } else if (tokens.length > 1) {
        // Multi-word replacement — save the whole original as a phrase fix
        // using the full corrected string (joined)
        void saveGlossaryEntry(original.word, tokens.join(" "));
      }
    }

    onWordsChange(next);
    cancelEdit();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="text-sm font-semibold">Captions</div>
        <span className="text-[10px] text-[var(--text-muted)]">
          Click to edit · Double-click to replace · Enter saves
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {lines.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
            No captions yet.
          </div>
        ) : (
          lines.map((line, i) => {
            const keywordIdx = pickKeywordIndex(line);
            const lineFirstStart = line.words[0].start;
            // Always WRITE under the canonical (exact) key; READ via
            // fuzzy matcher so a slightly drifted override still shows
            // the correct ⚡ state on this row.
            const lKey = lineKey(lineFirstStart);
            const resolved = resolveOverrideKey(lineFirstStart, lineAnimations);
            const currentVariant = resolved?.variant;
            const isPopoverOpen = animPopoverLineKey === lKey;
            return (
              <div
                key={`${line.startIndex}-${lineFirstStart}`}
                className="group relative flex items-start gap-2 rounded-md px-3 py-2 hover:bg-[var(--bg-hover)]"
              >
                <span className="mt-0.5 w-5 shrink-0 text-xs font-medium text-[var(--text-muted)]">
                  {i + 1}
                </span>
                {onLineAnimationChange && (
                  <button
                    type="button"
                    onClick={() => setAnimPopoverLineKey(isPopoverOpen ? null : lKey)}
                    title={
                      currentVariant
                        ? `Animation: ${currentVariant} (click to change)`
                        : "Set per-line animation"
                    }
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] transition ${
                      currentVariant
                        ? "bg-[var(--accent)] text-white"
                        : "text-[var(--text-muted)] opacity-0 hover:bg-[var(--bg-elevated)] hover:text-[var(--text)] group-hover:opacity-100"
                    }`}
                  >
                    {/* Lightning glyph keeps the row tight; full label
                        lives inside the popover. */}
                    ⚡
                  </button>
                )}
                {isPopoverOpen && onLineAnimationChange && (
                  <div className="absolute left-12 top-9 z-20 flex flex-col gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-1 shadow-xl">
                    {ENTRANCE_VARIANT_CYCLE.map((variant) => {
                      const isSelected = currentVariant === variant;
                      return (
                        <button
                          key={variant}
                          type="button"
                          onClick={() => {
                            onLineAnimationChange(lKey, variant);
                            setAnimPopoverLineKey(null);
                          }}
                          className={`whitespace-nowrap rounded px-2 py-1 text-left text-[11px] transition ${
                            isSelected
                              ? "bg-[var(--accent)] text-white"
                              : "text-[var(--text)] hover:bg-[var(--bg-hover)]"
                          }`}
                        >
                          {VARIANT_LABELS[variant]}
                        </button>
                      );
                    })}
                    {currentVariant && (
                      <>
                        <div className="my-0.5 h-px bg-[var(--border)]" />
                        <button
                          type="button"
                          onClick={() => {
                            // Delete whichever key the fuzzy matcher
                            // actually found — `lKey` (canonical) and
                            // `resolved.key` can differ after a
                            // re-transcribe. Falling back to lKey
                            // covers the no-fuzzy-match case.
                            onLineAnimationChange(resolved?.key ?? lKey, null);
                            setAnimPopoverLineKey(null);
                          }}
                          className="rounded px-2 py-1 text-left text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                        >
                          Reset to default
                        </button>
                      </>
                    )}
                  </div>
                )}
                <div className="flex flex-1 flex-wrap items-center gap-1.5 text-sm leading-relaxed">
                  {line.words.map((w, j) => {
                    const absoluteIdx = line.startIndex + j;
                    const isKeyword = j === keywordIdx;
                    const isEditing = editingIndex === absoluteIdx;

                    if (isEditing) {
                      return (
                        <input
                          key={`edit-${absoluteIdx}`}
                          ref={inputRef}
                          type="text"
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={onKeyDown}
                          onBlur={commitEdit}
                          // Double-click selects all — opt-in path for
                          // users who want to retype the whole word in
                          // one shot. Single-click parks the cursor at
                          // the end so single-letter fixes work.
                          onDoubleClick={(e) => e.currentTarget.select()}
                          // Width auto-grows with content — `ch` units track the
                          // character count for a roughly correct width.
                          style={{ width: `${Math.max(2, editingValue.length + 1)}ch` }}
                          className="rounded-md border border-[var(--accent)] bg-[var(--bg)] px-2 py-0.5 text-xs font-medium text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                        />
                      );
                    }

                    const baseCls =
                      "rounded-md px-2 py-0.5 text-xs cursor-text transition";
                    const wordKey = String((w.start * 100) | 0);
                    const sizeMul = wordSizes?.[wordKey] ?? 1;
                    const STEP = 0.15;
                    const MIN = 0.5;
                    const MAX = 2.5;
                    const adjust = (delta: number) => {
                      if (!onWordSizesChange) return;
                      const next = Math.max(
                        MIN,
                        Math.min(MAX, Number((sizeMul + delta).toFixed(2)))
                      );
                      const updated = { ...(wordSizes ?? {}) };
                      if (Math.abs(next - 1) < 0.001) {
                        delete updated[wordKey];
                      } else {
                        updated[wordKey] = next;
                      }
                      onWordSizesChange(updated);
                    };
                    const wordSpan = isKeyword ? (
                      <span
                        onClick={() => beginEdit(absoluteIdx, w.word)}
                        className={`${baseCls} border border-[var(--accent)] bg-[var(--accent-bg)] font-medium text-[var(--accent)] hover:brightness-125`}
                      >
                        {w.word}
                      </span>
                    ) : (
                      <span
                        onClick={() => beginEdit(absoluteIdx, w.word)}
                        className={`${baseCls} text-[var(--text)] hover:bg-[var(--bg-elevated)] hover:underline decoration-dotted underline-offset-2`}
                      >
                        {w.word}
                      </span>
                    );
                    return (
                      <span
                        key={`${absoluteIdx}-${w.start}`}
                        className="group/word relative inline-flex items-center gap-1"
                      >
                        {wordSpan}
                        {/* Resize controls — visible on hover, OR always
                            when a non-default multiplier is set so the user
                            can revert easily. */}
                        <span
                          className={`inline-flex items-center gap-0.5 transition-opacity ${
                            sizeMul !== 1
                              ? "opacity-100"
                              : "opacity-0 group-hover/word:opacity-100"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); adjust(-STEP); }}
                            disabled={sizeMul <= MIN + 0.001}
                            className="flex h-4 w-4 items-center justify-center rounded border border-[var(--border-subtle)] text-[10px] leading-none text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-30"
                            title="Shrink word"
                          >
                            −
                          </button>
                          <span
                            className={`min-w-[26px] text-center text-[9px] tabular-nums ${
                              sizeMul !== 1 ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
                            }`}
                          >
                            {Math.round(sizeMul * 100)}%
                          </span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); adjust(STEP); }}
                            disabled={sizeMul >= MAX - 0.001}
                            className="flex h-4 w-4 items-center justify-center rounded border border-[var(--border-subtle)] text-[10px] leading-none text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-30"
                            title="Enlarge word"
                          >
                            +
                          </button>
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
