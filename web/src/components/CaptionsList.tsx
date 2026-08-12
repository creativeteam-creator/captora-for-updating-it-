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
import type { PlayerRef } from "@remotion/player";
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
  /** User-forced line breaks: indexes in `words[]` after which the
   *  grouper must start a new line. Toggled by the ⏎ button rendered
   *  between adjacent words. */
  userBreaks?: Set<number>;
  onUserBreaksChange?: (next: Set<number>) => void;
  /** Live playhead sync: when wired, the captions list auto-scrolls
   *  to the word currently under the playhead and highlights it. Saves
   *  the user from manually searching for the line that's playing —
   *  the issue Mac users were reporting on long videos. */
  playerRef?: React.RefObject<PlayerRef | null>;
  fps?: number;
}

export function CaptionsList({
  words, onWordsChange, lineAnimations, onLineAnimationChange,
  wordSizes, onWordSizesChange,
  userBreaks, onUserBreaksChange,
  playerRef, fps = 30,
}: Props) {
  // Pass user-defined break points to the grouper so the displayed
  // lines match what the renderer will produce (Remotion side also
  // receives userBreaks via CaptionsCompositionProps).
  const lines = useMemo(
    () => groupWordsIntoLines(words, { userBreaks }),
    [words, userBreaks]
  );
  // Toggle a break AFTER word index `idx`. Click ⏎ between word N
  // and word N+1 — adds N to userBreaks (splits the line); click
  // again removes it (merges back).
  const toggleBreak = useCallback(
    (idx: number) => {
      if (!onUserBreaksChange) return;
      const next = new Set(userBreaks ?? []);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      onUserBreaksChange(next);
    },
    [userBreaks, onUserBreaksChange]
  );
  // Absolute index of the word currently in edit mode, or null when none.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Playhead sync (issue #4) ──────────────────────────────────────────
  // Subscribe to the Player's frameupdate so we know which word is "live"
  // right now, then scroll that line into view. Without this, on long
  // videos the user has to scroll the captions panel by hand to find the
  // line being spoken — every Mac user reported this as friction.
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const player = playerRef?.current;
    if (!player) return;
    const handleFrame = (e: { detail: { frame: number } }) => {
      const sec = e.detail.frame / fps;
      // Binary search would be marginally faster but linear is fine even
      // for 4000-word transcripts — the loop body is a single compare.
      let idx: number | null = null;
      for (let i = 0; i < words.length; i++) {
        if (sec >= words[i].start && sec < words[i].end) { idx = i; break; }
        if (sec < words[i].start) break;
      }
      setActiveWordIndex(idx);
    };
    player.addEventListener("frameupdate", handleFrame);
    return () => player.removeEventListener("frameupdate", handleFrame);
  }, [playerRef, fps, words]);
  // Auto-scroll: when the active line changes, bring it into view.
  // `block: "nearest"` only scrolls when the line is off-screen — won't
  // fight the user if they manually scroll away to inspect a different
  // line. We also debounce by gating on "active line moved" — without
  // that, every frame would trigger a layout calc.
  const [activeLineKey, setActiveLineKey] = useState<string | null>(null);
  useEffect(() => {
    if (activeWordIndex === null) { setActiveLineKey(null); return; }
    const w = words[activeWordIndex];
    if (!w) return;
    setActiveLineKey(lineKey(w.start));
  }, [activeWordIndex, words]);
  useEffect(() => {
    if (activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeLineKey]);
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

  // Remove one word from the source array. The line-grouping re-computes
  // on the next render, so a 4-word line becomes 3, and a 1-word line
  // disappears entirely. Undo brings the word back (parent records an
  // editor snapshot inside onWordsChange).
  const deleteWord = useCallback(
    (absoluteIdx: number) => {
      if (!onWordsChange) return;
      const next = words.slice();
      next.splice(absoluteIdx, 1);
      onWordsChange(next);
    },
    [words, onWordsChange]
  );

  // Remove every word that belongs to a line — used by the per-line
  // trash button. `startIndex` and `count` come straight from the
  // CaptionLine the user clicked.
  // Insert a fresh word AFTER absoluteIdx (or at index 0 when -1).
  // The new word takes up the gap between its neighbours, clamped to
  // 50ms minimum so it's always at least visible on the timeline.
  // Issue #3 — Mac users had no way to add a missed word without
  // jumping to the timeline strip; this puts the affordance right in
  // the captions list where they're already editing.
  const insertWord = useCallback(
    (afterIdx: number) => {
      if (!onWordsChange) return;
      const prev = words[afterIdx];
      const next = words[afterIdx + 1];
      const start = prev ? prev.end : 0;
      const end = next ? next.start : start + 0.4;
      // Squeeze in if neighbours are touching — give 100ms either side.
      const span = Math.max(0.05, end - start);
      const inserted: WhisperWord = {
        word: "new",
        start: start + span * 0.25,
        end: start + span * 0.75,
      };
      const updated = [...words];
      updated.splice(afterIdx + 1, 0, inserted);
      onWordsChange(updated);
      // Drop straight into edit mode so the user just types the word.
      setEditingIndex(afterIdx + 1);
      setEditingValue("new");
    },
    [words, onWordsChange]
  );

  const deleteLine = useCallback(
    (startIndex: number, count: number) => {
      if (!onWordsChange) return;
      const next = words.slice();
      next.splice(startIndex, count);
      onWordsChange(next);
    },
    [words, onWordsChange]
  );

  // ── Find & Replace ────────────────────────────────────────────────────
  // Toggled with Ctrl/Cmd+F. Case-insensitive substring match against
  // each word's text. Prev/Next cycle through matches; Replace swaps
  // the current match; Replace All swaps every match in one go and
  // pushes one snapshot to the undo stack.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Indexes of words that contain the current query (case-insensitive).
  const matchIndexes = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i].word.toLowerCase().includes(q)) out.push(i);
    }
    return out;
  }, [findQuery, words]);

  // Reset the current-match pointer whenever the match set changes so
  // Enter/Next always lands on a valid index.
  useEffect(() => {
    if (currentMatch >= matchIndexes.length) setCurrentMatch(0);
  }, [matchIndexes.length, currentMatch]);

  // Ctrl+F / Cmd+F opens the find bar and focuses the input. Escape
  // closes. Global keydown listener — only active while this component
  // is mounted (which matches the editor's Captions tab lifetime).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (isMod && e.key.toLowerCase() === "f") {
        // Don't fight the browser's built-in find inside input/textarea.
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => findInputRef.current?.focus(), 0);
      } else if (e.key === "Escape" && findOpen) {
        setFindOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [findOpen]);

  const goToMatch = (delta: 1 | -1) => {
    if (matchIndexes.length === 0) return;
    setCurrentMatch(
      (matchIndexes.length + currentMatch + delta) % matchIndexes.length
    );
  };

  // Replace only the currently-highlighted match. Preserves the word's
  // start/end so per-word timings survive the edit.
  const replaceCurrent = () => {
    if (matchIndexes.length === 0 || !onWordsChange) return;
    const wordIdx = matchIndexes[currentMatch];
    const original = words[wordIdx];
    const q = findQuery.trim();
    if (!q) return;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const nextText = original.word.replace(re, replaceQuery);
    const next = [...words];
    next.splice(wordIdx, 1, { ...original, word: nextText });
    onWordsChange(next);
    // Advance to next match so repeated presses walk through.
    setTimeout(() => goToMatch(1), 0);
  };

  // Replace every occurrence across every word in one atomic update
  // (single undo entry via the parent's onWordsChange snapshot).
  const replaceAll = () => {
    if (matchIndexes.length === 0 || !onWordsChange) return;
    const q = findQuery.trim();
    if (!q) return;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const next = words.map((w) => {
      if (!w.word.toLowerCase().includes(q.toLowerCase())) return w;
      return { ...w, word: w.word.replace(re, replaceQuery) };
    });
    onWordsChange(next);
    setFindQuery("");
  };

  // Word index → position in the match list (or -1). Used by the
  // renderer to underline every match and mark the current one.
  const matchPositionByWordIdx = useMemo(() => {
    const map = new Map<number, number>();
    matchIndexes.forEach((idx, pos) => map.set(idx, pos));
    return map;
  }, [matchIndexes]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="text-sm font-semibold">Captions</div>
        <div className="flex items-center gap-2">
          {onWordsChange && (
            <button
              type="button"
              onClick={() => {
                setFindOpen((v) => !v);
                if (!findOpen) setTimeout(() => findInputRef.current?.focus(), 0);
              }}
              className={`flex h-6 w-6 items-center justify-center rounded-md border text-[11px] transition ${
                findOpen
                  ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--accent)]"
                  : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
              }`}
              title="Find & Replace (Ctrl/Cmd + F)"
              aria-label="Toggle Find & Replace"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.5-4.5" />
              </svg>
            </button>
          )}
          <span className="text-[10px] text-[var(--text-muted)]">
            Click to edit · Enter saves
          </span>
        </div>
      </div>

      {findOpen && (
        <div className="flex flex-col gap-1 border-b border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">
          <div className="flex items-center gap-1">
            <input
              ref={findInputRef}
              type="text"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  goToMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === "Escape") {
                  setFindOpen(false);
                }
              }}
              placeholder="Find"
              className="h-7 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            />
            <span className="min-w-[52px] shrink-0 text-center text-[10px] tabular-nums text-[var(--text-muted)]">
              {matchIndexes.length > 0
                ? `${currentMatch + 1}/${matchIndexes.length}`
                : "0/0"}
            </span>
            <button
              type="button"
              onClick={() => goToMatch(-1)}
              disabled={matchIndexes.length === 0}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-40 disabled:cursor-not-allowed"
              title="Previous match (Shift + Enter)"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => goToMatch(1)}
              disabled={matchIndexes.length === 0}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-40 disabled:cursor-not-allowed"
              title="Next match (Enter)"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => setFindOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (e.shiftKey) replaceAll();
                  else replaceCurrent();
                }
              }}
              placeholder="Replace with"
              className="h-7 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            />
            <button
              type="button"
              onClick={replaceCurrent}
              disabled={matchIndexes.length === 0}
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-40 disabled:cursor-not-allowed"
              title="Replace current match (Enter)"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={replaceAll}
              disabled={matchIndexes.length === 0}
              className="rounded-md border border-[var(--accent)] bg-[var(--accent-bg)] px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Replace all matches (Shift + Enter)"
            >
              All
            </button>
          </div>
        </div>
      )}

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
            const isActiveLine = activeLineKey === lKey;
            return (
              <div
                key={`${line.startIndex}-${lineFirstStart}`}
                ref={isActiveLine ? activeLineRef : null}
                className={`group relative flex items-start gap-2 rounded-md px-3 py-2 transition-colors ${
                  isActiveLine
                    ? "bg-[var(--accent-bg)] ring-1 ring-[var(--accent)]/40"
                    : "hover:bg-[var(--bg-hover)]"
                }`}
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
                {/* Per-line delete — removes every word that belongs to
                    this line. Hover-revealed to keep the row visually
                    quiet; click flips the whole row's caption away. Undo
                    is available from the editor's history stack. */}
                {onWordsChange && (
                  <button
                    type="button"
                    onClick={() => deleteLine(line.startIndex, line.words.length)}
                    title={`Delete line ${i + 1}`}
                    aria-label={`Delete line ${i + 1}`}
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] text-[var(--text-muted)] opacity-0 transition hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
                  >
                    🗑
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
                    const isActiveWord = activeWordIndex === absoluteIdx;
                    // Find/Replace highlighting: every match gets a soft
                    // amber background; the currently-selected match
                    // (that Prev/Next cycles through) gets a stronger
                    // amber ring so the user knows which one will
                    // change on "Replace".
                    const matchPos = matchPositionByWordIdx.get(absoluteIdx);
                    const isFindMatch = matchPos !== undefined;
                    const isCurrentMatch = isFindMatch && matchPos === currentMatch;
                    // Active-word pill: same accent color but full-fill +
                    // white text so the user can tell at a glance which
                    // word is being spoken right now. Wins over keyword
                    // styling because "what's playing" is more relevant
                    // than "what's the longest word in this line".
                    const wordSpan = isActiveWord ? (
                      <span
                        onClick={() => beginEdit(absoluteIdx, w.word)}
                        className={`${baseCls} bg-[var(--accent)] font-semibold text-white shadow-sm`}
                      >
                        {w.word}
                      </span>
                    ) : isCurrentMatch ? (
                      <span
                        onClick={() => beginEdit(absoluteIdx, w.word)}
                        className={`${baseCls} bg-amber-400 font-semibold text-black ring-2 ring-amber-500`}
                      >
                        {w.word}
                      </span>
                    ) : isFindMatch ? (
                      <span
                        onClick={() => beginEdit(absoluteIdx, w.word)}
                        className={`${baseCls} bg-amber-400/40 text-[var(--text)]`}
                      >
                        {w.word}
                      </span>
                    ) : isKeyword ? (
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
                    // Is this the last word in this rendered line? If
                    // not, we'll render a hover-revealed ⏎ button after
                    // the word so the user can split the line here.
                    const isLastInLine = j === line.words.length - 1;
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
                          {/* Per-word delete — removes just this token.
                              Same hover-reveal as the resize buttons so
                              the row stays clean until the user hovers a
                              word. Empty edits (clearing the text in
                              edit mode) also delete, but this button
                              skips the "open editor → erase → enter"
                              dance for one-click removal. */}
                          {onWordsChange && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); deleteWord(absoluteIdx); }}
                              className="flex h-4 w-4 items-center justify-center rounded border border-[var(--border-subtle)] text-[10px] leading-none text-[var(--text-muted)] hover:border-red-400 hover:bg-red-500/15 hover:text-red-400"
                              title="Delete word"
                              aria-label={`Delete word "${w.word}"`}
                            >
                              ×
                            </button>
                          )}
                          {/* Insert a new word after this one. The
                              user types its text in the auto-opened
                              editor; timing slots between this word's
                              end and the next word's start. Address
                              the long-standing "Whisper missed a word
                              and I have no way to add it" complaint. */}
                          {onWordsChange && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); insertWord(absoluteIdx); }}
                              className="flex h-4 w-4 items-center justify-center rounded border border-[var(--border-subtle)] text-[10px] leading-none text-[var(--text-muted)] hover:border-[var(--accent)] hover:bg-[var(--accent-bg)] hover:text-[var(--accent)]"
                              title="Insert a new word after this one"
                              aria-label={`Insert new word after "${w.word}"`}
                            >
                              +
                            </button>
                          )}
                          {/* Line-break toggle — splits the line after
                              this word, or merges back if a user break
                              is already set here. Only shown when this
                              isn't the last word in the rendered line
                              AND a userBreaks setter is wired up. */}
                          {!isLastInLine && onUserBreaksChange && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleBreak(absoluteIdx); }}
                              className="flex h-4 w-4 items-center justify-center rounded border border-[var(--border-subtle)] text-[10px] leading-none text-[var(--text-muted)] hover:border-[var(--accent)] hover:bg-[var(--accent-bg)] hover:text-[var(--accent)]"
                              title="Break line here"
                              aria-label={`Break line after "${w.word}"`}
                            >
                              ⏎
                            </button>
                          )}
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
