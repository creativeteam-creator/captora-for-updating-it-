import { staticFile } from "remotion";

/**
 * The compositions are used in two contexts:
 *   - Server render: caller passes a filename ("foo.mp4") staged inside the
 *     bundle's public/ folder. We resolve it via `staticFile()`.
 *   - Browser preview (Remotion Player): caller passes a `blob:` URL
 *     (from `URL.createObjectURL(file)`) for the user's local upload.
 *     `staticFile()` would mangle that, so we pass it through unchanged.
 *
 * Detection is by URL prefix — anything that already looks like a URL is
 * treated as one.
 */
export function resolveSrc(src: string): string {
  if (
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("blob:") ||
    src.startsWith("data:") ||
    src.startsWith("file://")
  ) {
    return src;
  }
  return staticFile(src);
}
