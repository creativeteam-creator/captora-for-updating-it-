/**
 * Public surface of the @captora/remotion workspace, consumed by the web
 * app via `transpilePackages`. The Studio + render entry stays at
 * `./index.ts` (which calls `registerRoot`); this file is import-only.
 */
export { BoldViral } from "./compositions/BoldViral";
export { CleanMedical } from "./compositions/CleanMedical";
export { TechMinimal } from "./compositions/TechMinimal";
export type { CaptionsCompositionProps, WhisperWord } from "./types";
export {
  ENTRANCE_VARIANT_CYCLE,
  DEFAULT_WORD_ENTRANCE_CYCLE,
  type EntranceVariant,
  type WordEntranceVariant,
} from "./lib/entranceVariants";
export {
  FONTS,
  FONT_CATEGORY_LABELS,
  GOOGLE_FONTS_URL,
  fontStack,
  type FontCategory,
  type FontDef,
} from "./lib/fonts";
