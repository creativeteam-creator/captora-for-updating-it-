/**
 * Dimension probing for dropped media. The editor used to assume every
 * upload was a 1080×1920 reel; now the preview canvas + the rendered MP4
 * both adapt to the source's actual aspect ratio so a horizontal YT clip
 * stays horizontal and a vertical reel stays vertical.
 *
 * Snapping: we round to the nearest standard format (9:16, 16:9, 1:1)
 * when the source aspect is within ~5% of one. Anything else keeps its
 * native aspect with the long edge capped at 1920 — both edges forced
 * even because h264 / ProRes encoders refuse odd dimensions.
 */

"use client";

export interface MediaDimensions {
  width: number;
  height: number;
}

const VIDEO_EXTS = /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i;

export async function probeVideoDimensions(file: File): Promise<MediaDimensions | null> {
  if (!file.type.startsWith("video/") && !VIDEO_EXTS.test(file.name)) return null;

  return new Promise<MediaDimensions | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.remove();
    };

    video.addEventListener("loadedmetadata", () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      cleanup();
      resolve(w > 0 && h > 0 ? { width: w, height: h } : null);
    });

    video.addEventListener("error", () => {
      cleanup();
      resolve(null);
    });

    // Hard timeout — some weird containers never fire loadedmetadata.
    setTimeout(() => { cleanup(); resolve(null); }, 5000);
  });
}

/**
 * Pick the canvas size for preview + render based on the source's
 * actual dimensions. Audio uploads (or unprobed sources) default to a
 * 9:16 reel canvas because that's still the most common output format.
 */
export function pickCanvasDimensions(src: MediaDimensions | null): MediaDimensions {
  if (!src || src.width === 0 || src.height === 0) {
    return { width: 1080, height: 1920 };
  }
  const aspect = src.width / src.height;
  const TOL = 0.05;

  // 9:16 reel
  if (Math.abs(aspect - 9 / 16) < TOL) return { width: 1080, height: 1920 };
  // 16:9 youtube
  if (Math.abs(aspect - 16 / 9) < TOL) return { width: 1920, height: 1080 };
  // 1:1 square
  if (Math.abs(aspect - 1) < TOL) return { width: 1080, height: 1080 };
  // 4:5 instagram feed
  if (Math.abs(aspect - 4 / 5) < TOL) return { width: 1080, height: 1350 };

  // Non-standard — keep source aspect, cap long edge at 1920, force even
  // for the encoder.
  const longEdge = Math.max(src.width, src.height);
  const scale = longEdge > 1920 ? 1920 / longEdge : 1;
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  return { width: w - (w % 2), height: h - (h % 2) };
}
