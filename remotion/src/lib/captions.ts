/**
 * Mirror of `web/src/lib/captions.ts` so the renderer can group words into
 * phrases without depending on the web workspace. Two consumers must stay
 * aligned: the editor's left captions list (web) and the composition's
 * phrase rendering (remotion). Same grouping rules → same look.
 */

import type { WhisperWord } from "../types";

export interface CaptionLine {
  startIndex: number;
  words: WhisperWord[];
}

interface GroupOptions {
  pauseThresholdSec?: number;
  maxWordsPerLine?: number;
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
