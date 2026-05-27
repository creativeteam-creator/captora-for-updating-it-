/**
 * Whisper produces one row per word. The editor's left panel shows captions
 * grouped into "lines" (a phrase the viewer reads at once) — typically 3–6
 * words, broken on natural pauses. This module is the source of truth for
 * that grouping; the renderer still uses the raw word array.
 */

import type { WhisperWord } from "./whisper";

export interface CaptionLine {
  /** Index in the source `words` array of the first word in this line. */
  startIndex: number;
  words: WhisperWord[];
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
}

const DEFAULT_OPTS: Required<Omit<GroupOptions, "userBreaks">> = {
  pauseThresholdSec: 0.4,
  maxWordsPerLine: 6,
  maxDurationSec: 3.0,
};

export function groupWordsIntoLines(
  words: WhisperWord[],
  opts: GroupOptions = {}
): CaptionLine[] {
  const { pauseThresholdSec, maxWordsPerLine, maxDurationSec } = { ...DEFAULT_OPTS, ...opts };
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
