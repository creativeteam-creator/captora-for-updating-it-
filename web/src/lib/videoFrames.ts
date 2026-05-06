/**
 * Filmstrip frame extraction for the timeline's Video track.
 *
 * `extractFrames(file, count)` returns N evenly-spaced JPEG data URLs
 * sampled from the video. Audio-only inputs throw — the caller should
 * skip the call when `mediaKind === "audio"`.
 *
 * One module-level cache per File reference + frame-count combo so
 * re-renders / zoom changes don't re-decode the video (each frame seek
 * costs ~50ms; a 30-frame strip is ~1.5s of work).
 *
 * The seek loop relies on the browser's `seeked` event firing after
 * each `currentTime` set. Mobile Safari is occasionally flaky here
 * (fires `seeked` before the frame is actually painted) — the
 * caller should treat the returned dataURLs as best-effort visual
 * hints, not pixel-accurate frame grabs.
 */

"use client";

interface ExtractedFrames {
  frames: string[]; // dataURL per frame, length = `count`
  durationSec: number;
}

const FILE_CACHE = new WeakMap<File, Map<number, Promise<ExtractedFrames>>>();

const VIDEO_EXTS = /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i;

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || VIDEO_EXTS.test(file.name);
}

export async function extractFrames(
  file: File,
  count: number,
  thumbWidth = 80,
  thumbHeight = 45
): Promise<ExtractedFrames> {
  if (count <= 0) return { frames: [], durationSec: 0 };
  if (!isVideoFile(file)) {
    throw new Error("extractFrames: not a video file");
  }

  let perFile = FILE_CACHE.get(file);
  if (!perFile) {
    perFile = new Map();
    FILE_CACHE.set(file, perFile);
  }
  const cached = perFile.get(count);
  if (cached) return cached;

  const promise = doExtract(file, count, thumbWidth, thumbHeight);
  perFile.set(count, promise);
  return promise;
}

async function doExtract(
  file: File,
  count: number,
  thumbWidth: number,
  thumbHeight: number
): Promise<ExtractedFrames> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;

  // Wait for metadata so we can read `duration`. A 5s safety timeout
  // catches weird containers that never fire `loadedmetadata`.
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const onMeta = () => {
      done = true;
      cleanup();
      resolve();
    };
    const onErr = () => {
      done = true;
      cleanup();
      reject(new Error("video metadata load failed"));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onErr);
    setTimeout(() => {
      if (!done) {
        cleanup();
        reject(new Error("video metadata timeout"));
      }
    }, 5000);
  });

  const durationSec = video.duration;
  const canvas = document.createElement("canvas");
  canvas.width = thumbWidth;
  canvas.height = thumbHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    URL.revokeObjectURL(url);
    throw new Error("2d canvas unavailable");
  }

  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    // Sample at the MIDDLE of each segment so the first / last frames
    // aren't black title cards. e.g. count=4 → seek to 12.5%, 37.5%,
    // 62.5%, 87.5% of duration.
    const t = ((i + 0.5) / count) * durationSec;
    try {
      // eslint-disable-next-line no-await-in-loop
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight);
      frames.push(canvas.toDataURL("image/jpeg", 0.6));
    } catch {
      // If a single seek/decode fails, push a transparent placeholder
      // so frame count stays correct.
      ctx.clearRect(0, 0, thumbWidth, thumbHeight);
      frames.push(canvas.toDataURL("image/jpeg", 0.6));
    }
  }

  URL.revokeObjectURL(url);
  video.remove();
  return { frames, durationSec };
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const onSeeked = () => {
      done = true;
      cleanup();
      resolve();
    };
    const onErr = () => {
      done = true;
      cleanup();
      reject(new Error(`seek to ${time}s failed`));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onErr, { once: true });
    video.currentTime = time;
    // 3s timeout per seek — covers slow disks / large files.
    setTimeout(() => {
      if (!done) {
        cleanup();
        reject(new Error(`seek to ${time}s timed out`));
      }
    }, 3000);
  });
}
