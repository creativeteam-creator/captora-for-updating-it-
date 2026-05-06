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

import { contextBridge, ipcRenderer } from "electron";

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
   *  on-disk path. Lets the renderer skip the Supabase upload entirely
   *  when running inside the Electron desktop wrapper. */
  saveSourceFile: (
    bytes: Uint8Array,
    ext: string,
    projectId: string
  ): Promise<string> =>
    ipcRenderer.invoke("captora:saveSourceFile", { bytes, ext, projectId }),

  /** Tells the renderer it's running inside the desktop wrapper —
   *  flips small UI bits (e.g. show "Open output folder" instead
   *  of "Download" after render). */
  isDesktop: true,
});
