import React from "react";
import { Composition } from "remotion";
import { BoldViral } from "./compositions/BoldViral";
import { CleanMedical } from "./compositions/CleanMedical";
import { TechMinimal } from "./compositions/TechMinimal";
import { CaptionsCompositionProps, WhisperWord } from "./types";

/**
 * Fallback frame rate. Used for the Studio preview, for audio-only
 * projects (no source frames to preserve), and whenever fps detection
 * fails. Real video renders override it with the source's own rate —
 * see resolveFps below.
 */
const FPS = 30;
const TAIL_BUFFER_SEC = 0.5;

// Mock words for the Studio preview. The real `words` get injected as
// inputProps when rendering programmatically from /api/render.
const MOCK_WORDS: WhisperWord[] = [
  { word: "Welcome",  start: 0.10, end: 0.55 },
  { word: "to",       start: 0.60, end: 0.78 },
  { word: "Captora",  start: 0.80, end: 1.35 },
  { word: "auto",     start: 1.40, end: 1.75 },
  { word: "captions", start: 1.80, end: 2.60 },
];

/**
 * Resolve the frame rate this render should run at.
 *
 * /api/render probes the source video and passes its real rate here, so
 * a 24fps film-look clip stays 24 and a 60fps clip stays 60 instead of
 * every export being resampled to 30 — which put judder on 24/25fps
 * footage and threw away half the frames of 60fps footage.
 *
 * Remotion accepts non-integer rates (it only requires finite and
 * positive), so NTSC rates like 23.976 and 29.97 pass through exactly
 * rather than being rounded to 24 / 30.
 */
function resolveFps(props: CaptionsCompositionProps): number {
  const raw = props.fps;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  return FPS;
}

/**
 * Compute durationInFrames from the props. Prefer `durationSec` (e.g. the
 * exact length of the source video) when provided, otherwise fall back to
 * the last word's end + a small tail buffer so the final caption isn't
 * truncated.
 *
 * Takes `fps` as an argument rather than reading `props.fps`: the
 * composition's frame rate is the RESOLVED one, and computing the
 * duration against a different number would make the output run long or
 * short by exactly the ratio between them.
 */
function computeDurationFrames(props: CaptionsCompositionProps, fps: number): number {
  if (props.durationSec && props.durationSec > 0) {
    return Math.ceil(props.durationSec * fps);
  }
  if (!props.words.length) return Math.ceil(TAIL_BUFFER_SEC * fps);
  const lastEnd = Math.max(...props.words.map((w) => w.end));
  return Math.ceil((lastEnd + TAIL_BUFFER_SEC) * fps);
}

/**
 * Dynamic metadata: lets the caller pass `fps` / `width` / `height` via
 * inputProps so the same composition adapts to the dropped media's frame
 * rate and aspect ratio. Both edges are forced even — h264 + ProRes
 * encoders refuse odd sides.
 *
 * Returning `fps` here is what actually changes the output file's frame
 * rate. Everything downstream follows automatically: CaptionsTimeline
 * reads `useVideoConfig().fps`, so caption timing lands on the same
 * frames it always did.
 */
function computeMetadata(props: CaptionsCompositionProps) {
  const fps = resolveFps(props);
  const meta: {
    fps: number;
    durationInFrames: number;
    width?: number;
    height?: number;
  } = {
    fps,
    durationInFrames: computeDurationFrames(props, fps),
  };
  if (props.width && props.height) {
    meta.width = Math.max(2, props.width - (props.width % 2));
    meta.height = Math.max(2, props.height - (props.height % 2));
  }
  return meta;
}

const baseDefaults: CaptionsCompositionProps = { words: MOCK_WORDS, fps: FPS };

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="BoldViral"
        component={BoldViral}
        durationInFrames={1}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={baseDefaults}
        calculateMetadata={({ props }: { props: CaptionsCompositionProps }) =>
          computeMetadata(props)
        }
      />
      <Composition
        id="CleanMedical"
        component={CleanMedical}
        durationInFrames={1}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={baseDefaults}
        calculateMetadata={({ props }: { props: CaptionsCompositionProps }) =>
          computeMetadata(props)
        }
      />
      <Composition
        id="TechMinimal"
        component={TechMinimal}
        durationInFrames={1}
        fps={FPS}
        width={1080}
        height={1920}
        defaultProps={baseDefaults}
        calculateMetadata={({ props }: { props: CaptionsCompositionProps }) =>
          computeMetadata(props)
        }
      />
    </>
  );
};
