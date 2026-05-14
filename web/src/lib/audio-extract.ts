/**
 * Extract a compressed audio track from any video/audio input using the
 * bundled `ffmpeg-static` binary. We use this for cloud STT providers
 * (ElevenLabs, Groq) that have file-size limits — a multi-GB video
 * shrinks to a few tens of MB at 128 kbps mono 16 kHz, which is also
 * exactly what Whisper-style models want internally.
 *
 * Local providers (faster-whisper-gpu, transformers.js Whisper) already
 * decode audio themselves so they get the original file path.
 */

import { spawn } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import ffmpegPath from "ffmpeg-static";

/**
 * Extracts audio from `inputPath` to a temporary MP3 file and returns
 * its path. The caller is responsible for `unlink`-ing the temp file
 * when done (use a try/finally — the file lives in the OS temp dir,
 * but we still clean up to avoid pile-up across long sessions).
 *
 * `bitrate` defaults to 128k — high quality, fine for ElevenLabs whose
 * upload limit is roomy. Pass "48k" or "64k" when targeting Groq, whose
 * hard request-size cap is ~25 MB.
 */
export async function extractAudioToMp3(
  inputPath: string,
  bitrate: string = "128k"
): Promise<string> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide a binary path for this platform");
  }

  const outputPath = join(tmpdir(), `captora-audio-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp3`);

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, [
      "-y",
      "-i", inputPath,
      "-vn",                // strip video
      "-acodec", "libmp3lame",
      "-b:a", bitrate,      // 128k for ElevenLabs (high quality), 48k for Groq (size-capped)
      "-ar", "16000",       // 16 kHz — Whisper / Scribe internal rate
      "-ac", "1",           // mono
      outputPath,
    ]);

    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg audio extraction failed (code ${code}): ${stderr.slice(-300)}`));
        return;
      }
      resolve(outputPath);
    });
  });
}
