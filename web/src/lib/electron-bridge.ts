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
 * Save a dropped File to the local sessions folder via IPC. Reads the
 * file as ArrayBuffer client-side, ships it to the Electron main process
 * which writes it to disk. Returns the absolute path on-disk.
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
  // Use Uint8Array for efficient IPC transfer — Electron's structured
  // clone moves the buffer's underlying memory rather than copying.
  const bytes = new Uint8Array(await file.arrayBuffer());
  return bridge.saveSourceFile(bytes, ext, projectId);
}
