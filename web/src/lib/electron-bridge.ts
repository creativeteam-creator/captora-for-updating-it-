/**
 * Typed wrapper around the IPC API that `electron/src/preload.ts` exposes
 * on `window.captora`. The renderer can detect "are we inside the desktop
 * wrapper?" with `isElectron()` and skip cloud calls when we are.
 *
 * Pure web mode = `window.captora` is undefined → all helpers no-op or
 * throw a clear error.
 */

"use client";

interface CaptoraBridge {
  pickMediaFile: () => Promise<string | null>;
  revealInOSFileManager: (path: string) => Promise<void>;
  saveSourceFile: (
    bytes: Uint8Array,
    ext: string,
    projectId: string
  ) => Promise<string>;
  /** Resolves the system path of a dropped File. Returns "" for
   *  Files that don't have an on-disk origin (very rare for drag-
   *  drop / file picker). */
  getFilePath?: (file: File) => string;
  /** Disk-to-disk copy from the source path into the local sessions
   *  folder. Constant memory, handles any file size. */
  copySourceFile?: (
    sourcePath: string,
    ext: string,
    projectId: string
  ) => Promise<string>;
  /** Read back a previously-saved source file for the renderer when
   *  reopening a project. Throws if the file is missing on disk. */
  readSourceFile?: (
    projectId: string,
    ext: string
  ) => Promise<ArrayBuffer>;
  isDesktop: true;
}

declare global {
  interface Window {
    captora?: CaptoraBridge;
  }
}

export function isElectron(): boolean {
  return typeof window !== "undefined" && window.captora?.isDesktop === true;
}

export function getBridge(): CaptoraBridge | null {
  if (typeof window === "undefined") return null;
  return window.captora ?? null;
}

/**
 * Save a dropped File to the local sessions folder. Picks the best
 * strategy based on what the bridge exposes:
 *
 *   1. **Path copy (preferred):** if the File has an on-disk origin
 *      (drag-drop or file picker — almost always), we resolve its
 *      system path via `webUtils.getPathForFile` in preload, then
 *      ask main to do a disk-to-disk copy. Constant-memory, handles
 *      30-min 1080p videos / 5 GB clips without breaking a sweat.
 *
 *   2. **Bytes IPC (fallback):** for synthetic Files without an
 *      on-disk origin (very rare), read the whole File as
 *      ArrayBuffer and ship through IPC. Memory-heavy — a 30-min
 *      video can OOM the renderer, showing a black screen while it
 *      crashes silently. We only take this path when no other
 *      option exists.
 *
 * Throws if not running inside Electron — caller should branch on
 * `isElectron()` first.
 */
export async function saveSourceFileLocally(
  file: File,
  ext: string,
  projectId: string
): Promise<string> {
  const bridge = getBridge();
  if (!bridge) {
    throw new Error(
      "saveSourceFileLocally called outside Electron desktop wrapper"
    );
  }

  // Preferred: path copy. Only available when both helpers are
  // exposed AND the File has a real on-disk origin.
  if (bridge.getFilePath && bridge.copySourceFile) {
    const systemPath = bridge.getFilePath(file);
    console.log(
      `[saveSourceFileLocally] getFilePath returned: ${systemPath ? `"${systemPath}"` : "(empty)"}`
    );
    if (systemPath) {
      try {
        const result = await bridge.copySourceFile(systemPath, ext, projectId);
        console.log(`[saveSourceFileLocally] copy OK → ${result}`);
        return result;
      } catch (err) {
        console.error("[saveSourceFileLocally] copySourceFile threw:", err);
        throw err;
      }
    }
  } else {
    console.warn(
      "[saveSourceFileLocally] copy helpers missing — falling back to bytes IPC. " +
        "(getFilePath: " +
        (bridge.getFilePath ? "yes" : "no") +
        ", copySourceFile: " +
        (bridge.copySourceFile ? "yes" : "no") +
        ")"
    );
  }

  // Fallback: bytes through IPC. Slow / memory-heavy on big files.
  console.log(
    `[saveSourceFileLocally] using bytes-IPC fallback for ${file.name} (${file.size} bytes)`
  );
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const result = await bridge.saveSourceFile(bytes, ext, projectId);
    console.log(`[saveSourceFileLocally] bytes write OK → ${result}`);
    return result;
  } catch (err) {
    console.error("[saveSourceFileLocally] saveSourceFile threw:", err);
    throw err;
  }
}

/**
 * Reopen a desktop-mode project's source file. Reads the bytes back
 * from `<userData>/sessions/<projectId><ext>` via IPC and wraps them
 * in a `File` so the editor can drive the Player like it does after
 * an upload.
 *
 * Throws if the bridge isn't available OR the file was removed (the
 * sessions cleanup sweep deletes files older than 12h). The caller
 * should surface a "re-upload to restore" error in that case.
 */
export async function readSourceFileLocally(
  projectId: string,
  ext: string,
  filename: string,
  mimeType?: string
): Promise<File> {
  const bridge = getBridge();
  if (!bridge?.readSourceFile) {
    throw new Error(
      "readSourceFileLocally called outside Electron desktop wrapper " +
        "(or running an older build without the readSourceFile IPC)"
    );
  }
  const buffer = await bridge.readSourceFile(projectId, ext);
  return new File([buffer], filename, { type: mimeType || "" });
}
