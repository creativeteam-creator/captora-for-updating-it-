/**
 * Convert Whisper word arrays into SRT / VTT subtitle strings so users
 * can download a sidecar file alongside the rendered MP4. Handy for
 * uploading to YouTube / Instagram / any editor that reads standard
 * subtitle formats — the platform can then render its own captions
 * instead of relying on our burnt-in ones.
 *
 * Both formats group words into lines using the same
 * `groupWordsIntoLines` heuristic the editor uses, so what you see in
 * the captions list is what the SRT/VTT file contains.
 */

import { groupWordsIntoLines } from "./captions";
import type { WhisperWord } from "./whisper";

interface Options {
  /** User-defined line breaks — mirrors the same option the editor
   *  passes to the grouper so the SRT lines match the on-screen
   *  captions exactly. */
  userBreaks?: Set<number>;
  /** Max words per line — passed to the grouper. Falls back to the
   *  grouper's default. */
  maxWordsPerLine?: number;
}

/** Format a seconds float as SRT timestamp "HH:MM:SS,mmm". */
function formatSrtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Format a seconds float as VTT timestamp "HH:MM:SS.mmm". */
function formatVttTime(seconds: number): string {
  // VTT uses the same shape as SRT but with a "." separator for ms.
  return formatSrtTime(seconds).replace(",", ".");
}

export function whisperWordsToSrt(
  words: WhisperWord[],
  opts: Options = {}
): string {
  if (words.length === 0) return "";
  const lines = groupWordsIntoLines(words, {
    userBreaks: opts.userBreaks,
    maxWordsPerLine: opts.maxWordsPerLine,
  });
  return lines
    .map((line, i) => {
      const start = line.words[0].start;
      const end = line.words[line.words.length - 1].end;
      const text = line.words.map((w) => w.word).join(" ");
      return `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}\n`;
    })
    .join("\n");
}

export function whisperWordsToVtt(
  words: WhisperWord[],
  opts: Options = {}
): string {
  if (words.length === 0) return "WEBVTT\n";
  const lines = groupWordsIntoLines(words, {
    userBreaks: opts.userBreaks,
    maxWordsPerLine: opts.maxWordsPerLine,
  });
  const body = lines
    .map((line) => {
      const start = line.words[0].start;
      const end = line.words[line.words.length - 1].end;
      const text = line.words.map((w) => w.word).join(" ");
      return `${formatVttTime(start)} --> ${formatVttTime(end)}\n${text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/**
 * Trigger a browser download of a text file with the given content.
 * Wraps the Blob → URL.createObjectURL → temporary <a> dance in one
 * call so the editor code can just say
 *   downloadTextFile("captions.srt", srtString)
 * and forget the plumbing.
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mime: string = "text/plain;charset=utf-8"
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on next tick so the click has time to consume the URL.
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
