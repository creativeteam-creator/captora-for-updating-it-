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
}

const DEFAULT_OPTS: Required<GroupOptions> = {
  pauseThresholdSec: 0.4,
  maxWordsPerLine: 6,
  maxDurationSec: 3.0,
};

export function groupWordsIntoLines(
  words: WhisperWord[],
  opts: GroupOptions = {}
): CaptionLine[] {
  const { pauseThresholdSec, maxWordsPerLine, maxDurationSec } = { ...DEFAULT_OPTS, ...opts };
  const lines: CaptionLine[] = [];
  let current: WhisperWord[] = [];
  let lineStartIdx = 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = current[current.length - 1];

    const gap = prev ? w.start - prev.end : 0;
    const lineDuration = current.length ? w.end - current[0].start : 0;

    const shouldBreak =
      current.length > 0 &&
      (gap > pauseThresholdSec ||
        current.length >= maxWordsPerLine ||
        lineDuration > maxDurationSec);

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
