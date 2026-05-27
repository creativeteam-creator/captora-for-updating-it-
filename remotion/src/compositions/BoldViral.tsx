import React from "react";
import { AbsoluteFill, Html5Audio, OffthreadVideo } from "remotion";
import { CAPTION_STYLES } from "../styles";
import { CaptionsTimeline } from "../components/CaptionsTimeline";
import { FontLoader } from "../components/FontLoader";
import { resolveSrc } from "../lib/resolveSrc";
import { CaptionsCompositionProps } from "../types";

export const BoldViral: React.FC<CaptionsCompositionProps> = ({
  words, videoSrc, audioSrc, style, transparentBackground, customFonts, lineAnimations, lineStyles, wordSizes, userBreaks,
}) => {
  const finalStyle = style ?? CAPTION_STYLES["bold-viral"];
  // Transparent renders skip the source video too — the user wants a
  // captions-only overlay to drop on their own footage. Audio still flows
  // because they may want it muxed; they can mute the track if not.
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
      />
    </AbsoluteFill>
  );
};
