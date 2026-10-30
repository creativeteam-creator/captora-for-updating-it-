/**
 * Whisper produces one row per word. The editor's left panel shows captions
 * grouped into "lines" (a phrase the viewer reads at once) — typically 3–6
 * words, broken on natural pauses. This module is the source of truth for
 * that grouping; the renderer still uses the raw word array.
 */

import type { WhisperWord } from "./whisper";

/**
 * Two centisecond-key strings (the `(word.start * 100) | 0` convention
 * used throughout the editor for lineAnimations / lineStyles /
 * lineOverrides / wordSizes / selectedLineKey) are "the same line"
 * within ±500ms. Mirrors the tolerance the renderer's own
 * `resolveLineOverride` / `resolveLineStyle` already use server-side
 * (remotion/src/components/CaptionsTimeline.tsx) and CaptionsList's
 * `resolveOverrideKey` uses for lineAnimations — this just makes the
 * same tolerance available wherever a raw `===` comparison is used
 * instead.
 *
 * Needed because deleting a line's first word changes which word is
 * "first" for that line, so its centisecond key shifts by however long
 * the deleted word was. Without fuzzy matching, `selectedLineKey`
 * (frozen at the moment the user clicked) silently stops matching any
 * line at all — the selection ring disappears and any per-line
 * template/override the user had picked stops applying, with nothing
 * in the UI explaining why.
 */
export function lineKeysAreClose(a: string, b: string, toleranceCentisec = 50): boolean {
  return Math.abs(Number(a) - Number(b)) <= toleranceCentisec;
}

/**
 * Look up `table[key]`, falling back to the nearest key within ±500ms
 * (see `lineKeysAreClose`) when there's no exact entry. Generic over the
 * value type so the same helper serves `lineStyles`
 * (`Record<string, CaptionStyleId>`) and `lineOverrides`
 * (`Record<string, CaptionStyleOverrides>`) alike.
 */
export function lookupNearLineKey<T>(
  table: Record<string, T> | undefined,
  key: string | null | undefined,
  toleranceCentisec = 50
): T | undefined {
  if (!table || !key) return undefined;
  if (key in table) return table[key];
  const target = Number(key);
  let best: { delta: number; value: T } | null = null;
  for (const [k, v] of Object.entries(table)) {
    const delta = Math.abs(Number(k) - target);
    if (delta > toleranceCentisec) continue;
    if (!best || delta < best.delta) best = { delta, value: v };
  }
  return best?.value;
}

export interface CaptionLine {
  /** Index in the source `words` array of the first word in this line. */
  startIndex: number;
  words: WhisperWord[];
}

/**
 * Remap `userBreaks` (word-index-keyed forced line breaks) after a
 * `words.splice(spliceStart, deleteCount, ...insertedItems)`-shaped edit.
 *
 * `userBreaks` records "start a new line after word i" as a raw array
 * index. Every editor mutation that inserts or removes words — splitting
 * a word into two, deleting a word, inserting a new one, deleting a
 * whole line — shifts every LATER word's index without this ever being
 * updated, so a break the user placed after "like" in "I really like
 * pizza" would silently land after "pizza" instead once an earlier edit
 * inserted a word. `applyCaptionTrim` already had to solve exactly this
 * for the IN/OUT trim case; this is the same fix generalised to every
 * splice-shaped edit so it isn't re-solved (or missed) at each call site.
 *
 * A break whose word fell INSIDE the deleted/replaced region is dropped
 * rather than reattached to a neighbour — the specific word the user
 * anchored it to is gone, and silently moving it to an unrelated word
 * is worse than losing it. Same-length replacements (delete 1, insert 1
 * — a pure text edit) are a no-op here since no index actually shifts.
 */
export function remapUserBreaksAfterSplice(
  userBreaks: Iterable<number>,
  spliceStart: number,
  deleteCount: number,
  insertCount: number
): Set<number> {
  const delta = insertCount - deleteCount;
  const next = new Set<number>();
  for (const idx of userBreaks) {
    if (idx < spliceStart) {
      next.add(idx);
    } else if (idx >= spliceStart + deleteCount) {
      next.add(idx + delta);
    }
    // else: idx falls inside the edited region — dropped.
  }
  return next;
}

interface GroupOptions {
  /** Break a line when the silence between consecutive words exceeds this (sec). */
  pauseThresholdSec?: number;
  /** Hard cap on words per line. */
  maxWordsPerLine?: number;
  /** Hard cap on line duration in seconds. */
  maxDurationSec?: number;
  /**
   * User-defined line breaks. Each entry is the index of a word AFTER
   * which the grouper MUST start a new line, regardless of the natural
   * gap / word-count / duration thresholds. Lets users override the
   * auto-grouping from the captions list (click the ⏎ between two
   * words to split a line).
   *
   * Example: userBreaks = new Set([4]) → words[0..4] form one line,
   * words[5..] start the next line.
   */
  userBreaks?: Set<number>;
  /**
   * "sentence" mode groups the WHOLE sentence into one caption line,
   * only breaking on sentence-terminating punctuation (.?!।|) or a
   * gap longer than 1.2s. Better for slower-reading audiences and
   * for content where each thought lands as one on-screen unit.
   * Default "phrase" mode keeps the short 3-6 word chunks tuned for
   * kinetic caption styles.
   */
  mode?: "phrase" | "sentence";
}

const DEFAULT_OPTS: Required<Omit<GroupOptions, "userBreaks" | "mode">> = {
  pauseThresholdSec: 0.4,
  maxWordsPerLine: 6,
  maxDurationSec: 3.0,
};

/**
 * Apply the caption IN/OUT trim to a word list AND remap the user's
 * forced line breaks onto the surviving words.
 *
 * The trim and the breaks have to move together. `userBreaks` holds
 * indexes into the FULL word array, but everything downstream — the
 * preview, the render, the SRT export — receives the FILTERED array.
 * Filtering the words while passing the original indexes through means
 * every break lands on whatever word happens to sit at that position
 * after the shift, so setting an IN point silently scattered the user's
 * line splits across unrelated words.
 *
 * A break marks "start a new line after word i". When word i is trimmed
 * away the break has nothing left to attach to, so it is dropped rather
 * than slid onto a neighbour — a split the user placed at a specific
 * word shouldn't reappear somewhere they didn't choose.
 *
 * `null` on either endpoint means "no trim on that end", which makes the
 * no-trim case a plain copy with the breaks unchanged.
 */
export function applyCaptionTrim(
  words: WhisperWord[],
  userBreaks: Iterable<number> | undefined,
  inSec: number | null | undefined,
  outSec: number | null | undefined
): { words: WhisperWord[]; userBreaks: number[] } {
  const breakSet = userBreaks instanceof Set ? userBreaks : new Set(userBreaks ?? []);
  const keptWords: WhisperWord[] = [];
  const keptBreaks: number[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // Symmetric with the outSec check below: a word straddling the IN
    // point (started slightly before it but still mostly plays after)
    // is kept, not dropped. The old `w.start < inSec` check dropped any
    // word that had started before the cut even if most of its audio
    // played after it — e.g. start=4.9/end=5.5 with inSec=5.0 got
    // dropped entirely, leaving a caption gap right where audio starts.
    if (inSec != null && w.end <= inSec) continue;
    if (outSec != null && w.start > outSec) continue;
    // Record the break at this word's NEW index before pushing it, so
    // the stored value indexes into `keptWords`, not the source array.
    if (breakSet.has(i)) keptBreaks.push(keptWords.length);
    keptWords.push(w);
  }

  return { words: keptWords, userBreaks: keptBreaks };
}

export function groupWordsIntoLines(
  words: WhisperWord[],
  opts: GroupOptions = {}
): CaptionLine[] {
  const mode = opts.mode ?? "phrase";
  // Sentence mode loosens the word-count + duration caps so a whole
  // sentence can render as one line. Pause threshold widens so a
  // natural mid-sentence beat doesn't split the caption.
  const sentenceDefaults = { pauseThresholdSec: 1.2, maxWordsPerLine: 40, maxDurationSec: 12 };
  const merged =
    mode === "sentence"
      ? { ...DEFAULT_OPTS, ...sentenceDefaults, ...opts }
      : { ...DEFAULT_OPTS, ...opts };
  const { pauseThresholdSec, maxWordsPerLine, maxDurationSec } = merged;
  const userBreaks = opts.userBreaks;
  const lines: CaptionLine[] = [];
  let current: WhisperWord[] = [];
  let lineStartIdx = 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = current[current.length - 1];

    const gap = prev ? w.start - prev.end : 0;
    const lineDuration = current.length ? w.end - current[0].start : 0;

    // User-forced break: when the previous word's index is in
    // userBreaks, start a new line BEFORE adding this word — i.e.
    // the break is "after word N", so words[N+1...] go to the next
    // line. This wins over the auto thresholds in either direction.
    const forcedBreak =
      current.length > 0 && userBreaks ? userBreaks.has(i - 1) : false;

    // Auto sentence-end break: if the previous word's text ends in a
    // sentence-terminating mark (.?! plus Devanagari danda ।, ElevenLabs's
    // pipe |), break the line after it. Lets the grouper respect natural
    // sentence boundaries even when the audio gap was tight — typical
    // Hindi/Hinglish where speakers chain sentences with no pause but
    // the LLM polish still inserts proper punctuation.
    const prevWord = prev?.word ?? "";
    const sentenceEndBreak =
      current.length > 0 && /[.!?।|]+\s*$/.test(prevWord);

    const shouldBreak =
      forcedBreak ||
      sentenceEndBreak ||
      (current.length > 0 &&
        (gap > pauseThresholdSec ||
          current.length >= maxWordsPerLine ||
          lineDuration > maxDurationSec));

    if (shouldBreak) {
      lines.push({ startIndex: lineStartIdx, words: current });
      current = [];
      lineStartIdx = i;
    }
    if (current.length === 0) lineStartIdx = i;
    current.push(w);
  }

  if (current.length > 0) {
    lines.push({ startIndex: lineStartIdx, words: current });
  }
  return lines;
}

/**
 * Heuristic for which words within a line should look "highlighted" (boxed
 * with the accent colour) — we emphasise proper nouns and the longest
 * word as the visual anchor. Cheap-and-cheerful version: pick the longest
 * word per line as the keyword.
 */
export function pickKeywordIndex(line: CaptionLine): number | null {
  if (line.words.length <= 1) return null;
  let bestIdx = 0;
  let bestLen = line.words[0].word.length;
  for (let i = 1; i < line.words.length; i++) {
    const len = line.words[i].word.length;
    if (len > bestLen) { bestLen = len; bestIdx = i; }
  }
  // Only call it a keyword if it's clearly longer than its neighbours.
  return bestLen >= 5 ? bestIdx : null;
}
