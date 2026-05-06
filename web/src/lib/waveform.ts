/**
 * Audio peak extraction for the timeline waveform.
 *
 * `decodePeaks(file, bucketCount)` returns a Float32Array of length
 * `bucketCount` where each value is the max absolute sample amplitude
 * (0..1) inside that bucket. Bucket count = pixel width of the canvas
 * we're drawing into; one column = one peak, simple bar drawing.
 *
 * One module-level cache per File reference so re-rendering the
 * Timeline at a new zoom level doesn't re-decode the audio (a 30-min
 * mp3 takes 5+ seconds to decode through Web Audio API).
 *
 * Audio-only inputs (mp3 / wav / m4a) decode directly. Video inputs
 * (mp4 / mov) — Web Audio happily decodes the audio track because
 * `decodeAudioData` follows the same WebCodecs path the browser uses
 * for `<video>` audio rendering.
 */

"use client";

interface DecodedPeaks {
  /** Source-file peak amplitudes downsampled into N buckets. */
  peaks: Float32Array;
  /** Bucket count the peaks were sampled to (always equals peaks.length). */
  buckets: number;
}

interface CacheEntry {
  /** All-channels-merged mono samples at original sample rate. */
  samples: Float32Array;
  /** Cached bucketed peaks keyed by bucketCount so common zoom levels
   *  reuse the same downsample work. */
  peakCache: Map<number, Float32Array>;
}

const FILE_CACHE = new WeakMap<File, Promise<CacheEntry>>();

async function decodeFileToMono(file: File): Promise<CacheEntry> {
  const buffer = await file.arrayBuffer();
  // OfflineAudioContext would let us downsample but here we just want
  // peaks — the cheaper path is decode-then-bucket on the main thread.
  const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const audio = await ctx.decodeAudioData(buffer);
  // Average all channels into mono — no need for per-channel peaks
  // since the timeline draws a single-channel bar graph.
  const channelCount = audio.numberOfChannels;
  const length = audio.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channelCount; ch++) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += data[i];
    }
  }
  if (channelCount > 1) {
    const inv = 1 / channelCount;
    for (let i = 0; i < length; i++) mono[i] *= inv;
  }
  // Close immediately — leaving the AudioContext open burns CPU
  // (Chromium keeps the audio thread warm).
  void ctx.close();
  return { samples: mono, peakCache: new Map() };
}

/**
 * Decode `file` (or read from cache) and return downsampled peaks for
 * the requested bucket count. Throws if the file isn't decodable as
 * audio (rare with modern browsers; common audio + video containers
 * all work).
 */
export async function decodePeaks(
  file: File,
  bucketCount: number
): Promise<DecodedPeaks> {
  if (bucketCount <= 0) return { peaks: new Float32Array(0), buckets: 0 };

  let pending = FILE_CACHE.get(file);
  if (!pending) {
    pending = decodeFileToMono(file);
    FILE_CACHE.set(file, pending);
  }
  const entry = await pending;

  const cached = entry.peakCache.get(bucketCount);
  if (cached) return { peaks: cached, buckets: bucketCount };

  const { samples } = entry;
  const peaks = new Float32Array(bucketCount);
  const samplesPerBucket = Math.max(1, Math.floor(samples.length / bucketCount));
  for (let b = 0; b < bucketCount; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(samples.length, start + samplesPerBucket);
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      const abs = v < 0 ? -v : v;
      if (abs > max) max = abs;
    }
    peaks[b] = max;
  }
  entry.peakCache.set(bucketCount, peaks);
  return { peaks, buckets: bucketCount };
}
