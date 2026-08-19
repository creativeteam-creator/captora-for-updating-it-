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
  /** Indexes after which the grouper MUST start a new line. Mirrors
   *  the user-defined line breaks set in the captions editor. */
  userBreaks?: Set<number>;
  /** "phrase" (default) = short 3-6 word chunks; "sentence" = whole
   *  sentence per caption line. Mirror of the web-side option so the
   *  rendered MP4 matches the editor's display. */
  mode?: "phrase" | "sentence";
}

const DEFAULT_OPTS: Required<Omit<GroupOptions, "userBreaks" | "mode">> = {
  pauseThresholdSec: 0.4,
  maxWordsPerLine: 6,
  maxDurationSec: 3.0,
};

export function groupWordsIntoLines(
  words: WhisperWord[],
  opts: GroupOptions = {}
): CaptionLine[] {
  const mode = opts.mode ?? "phrase";
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

    const forcedBreak =
      current.length > 0 && userBreaks ? userBreaks.has(i - 1) : false;

    // Auto sentence-end break (mirror of web/captions.ts): break when
    // the previous word ended in .?!।| — keeps the renderer in lockstep
    // with the editor's display whenever the LLM polish step has
    // inserted proper sentence punctuation.
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
