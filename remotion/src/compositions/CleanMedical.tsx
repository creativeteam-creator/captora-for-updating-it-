import React from "react";
import { AbsoluteFill, Html5Audio, OffthreadVideo } from "remotion";
import { CAPTION_STYLES } from "../styles";
import { CaptionsTimeline } from "../components/CaptionsTimeline";
import { FontLoader } from "../components/FontLoader";
import { resolveSrc } from "../lib/resolveSrc";
import { CaptionsCompositionProps } from "../types";

export const CleanMedical: React.FC<CaptionsCompositionProps> = ({
  words, videoSrc, audioSrc, style, transparentBackground, customFonts, lineAnimations, lineStyles, wordSizes, userBreaks, captionMode,
}) => {
  const finalStyle = style ?? CAPTION_STYLES["clean-medical"];
  const showVideo = !transparentBackground && videoSrc;
  return (
    <AbsoluteFill style={{ backgroundColor: transparentBackground ? "transparent" : "#000" }}>
      <FontLoader customFonts={customFonts} />
      {showVideo && (
        <AbsoluteFill>
          <OffthreadVideo src={resolveSrc(videoSrc!)} />
        </AbsoluteFill>
      )}
      {audioSrc && <Html5Audio src={resolveSrc(audioSrc)} />}
      <CaptionsTimeline
        words={words}
        style={finalStyle}
        lineAnimations={lineAnimations}
        lineStyles={lineStyles}
        wordSizes={wordSizes}
        userBreaks={userBreaks}
        captionMode={captionMode}
      />
    </AbsoluteFill>
  );
};
