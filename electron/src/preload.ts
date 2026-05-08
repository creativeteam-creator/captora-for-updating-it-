/**
 * Preload script — bridges trusted Node APIs into the (untrusted)
 * renderer via contextBridge. The renderer (Captora's Next.js UI)
 * only sees what we expose here, never the raw Node modules.
 *
 * Currently small — exposes a native file picker that the upload
 * hero can use instead of `<input type="file">` for a more native
 * desktop feel. Will grow as we add OS integrations (notifications,
 * tray, drag-and-drop registration).
 */

import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("captora", {
  /** Opens the native OS file dialog. Returns the absolute path of
   *  the chosen file, or null when the user cancelled. */
  pickMediaFile: (): Promise<string | null> =>
    ipcRenderer.invoke("captora:pickMediaFile"),

  /** Reveal a path in Finder (Mac) or Explorer (Windows). Used to
   *  jump to the renders folder after a successful export. */
  revealInOSFileManager: (path: string): Promise<void> =>
    ipcRenderer.invoke("captora:revealInOSFileManager", path),

  /** Save a dropped File's bytes to the local sessions folder under
   *  `<userData>/sessions/<projectId><ext>`. Returns the absolute
   *  on-disk path. Slow + memory-heavy on large files because the
   *  whole buffer goes through IPC; prefer `getFilePath` +
   *  `copySourceFile` whenever possible. */
  saveSourceFile: (
    bytes: Uint8Array,
    ext: string,
    projectId: string
  ): Promise<string> =>
    ipcRenderer.invoke("captora:saveSourceFile", { bytes, ext, projectId }),

  /** Resolve the system path of a dragged-or-picked File. Available
   *  for files that came from the user's filesystem (drag-drop, file
   *  picker). Returns "" for synthetic Files (created in JS, no
   *  on-disk origin). Lets us skip ArrayBuffer reads on multi-GB
   *  videos — instead we just hand the path to `copySourceFile`. */
  getFilePath: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },

  /** Copy a file from `sourcePath` (on the user's disk anywhere) into
   *  `<userData>/sessions/<projectId><ext>`. Returns the destination
   *  path. Disk-to-disk copy — no buffering, handles arbitrary file
   *  sizes (3 GB, 10 GB, doesn't matter). */
  copySourceFile: (
    sourcePath: string,
    ext: string,
    projectId: string
  ): Promise<string> =>
    ipcRenderer.invoke("captora:copySourceFile", {
      sourcePath,
      ext,
      projectId,
    }),

  /** Read back a previously-saved local source file when the user
   *  reopens a desktop project. Returns the bytes as ArrayBuffer so
   *  the renderer can wrap them in a `File` for the editor. Throws
   *  if the file was deleted (sessions cleanup sweep, manual
   *  removal, etc.) — caller should fall back to a friendly error. */
  readSourceFile: (
    projectId: string,
    ext: string
  ): Promise<ArrayBuffer> =>
    ipcRenderer.invoke("captora:readSourceFile", { projectId, ext }),

  /** Tells the renderer it's running inside the desktop wrapper —
   *  flips small UI bits (e.g. show "Open output folder" instead
   *  of "Download" after render). */
  isDesktop: true,
});
