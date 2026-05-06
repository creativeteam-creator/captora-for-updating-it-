import React from "react";
import { Composition } from "remotion";
import { BoldViral } from "./compositions/BoldViral";
import { CleanMedical } from "./compositions/CleanMedical";
import { TechMinimal } from "./compositions/TechMinimal";
import { CaptionsCompositionProps, WhisperWord } from "./types";

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
 * Compute durationInFrames from the props. Prefer `durationSec` (e.g. the
 * exact length of the source video) when provided, otherwise fall back to
 * the last word's end + a small tail buffer so the final caption isn't
 * truncated.
 */
function computeDurationFrames(props: CaptionsCompositionProps): number {
  if (props.durationSec && props.durationSec > 0) {
    return Math.ceil(props.durationSec * props.fps);
  }
  if (!props.words.length) return Math.ceil(TAIL_BUFFER_SEC * props.fps);
  const lastEnd = Math.max(...props.words.map((w) => w.end));
  return Math.ceil((lastEnd + TAIL_BUFFER_SEC) * props.fps);
}

/**
 * Dynamic metadata: lets the caller pass `width` / `height` via inputProps
 * so the same composition adapts to the dropped media's aspect ratio.
 * Both edges are forced even — h264 + ProRes encoders refuse odd sides.
 */
function computeMetadata(props: CaptionsCompositionProps) {
  const meta: { durationInFrames: number; width?: number; height?: number } = {
    durationInFrames: computeDurationFrames(props),
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
