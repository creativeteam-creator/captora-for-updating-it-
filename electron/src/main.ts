/**
 * Captora desktop wrapper — Electron main process entry point.
 *
 * Lifecycle:
 *   1. Wait for app ready
 *   2. Spawn embedded Next.js standalone server (or use localhost:3000 in dev)
 *   3. Open the BrowserWindow pointing at that server
 *   4. Wire IPC handlers (file picker, reveal-in-OS)
 *   5. Start temp-folder cleanup timer
 *   6. Set up auto-updater
 *
 * On quit:
 *   - Kill the Next.js child process
 *   - Stop the cleanup timer
 *
 * Security posture:
 *   - contextIsolation: true (renderer can't reach Node directly)
 *   - nodeIntegration: false (same)
 *   - All native ops go through preload.ts → IPC → main
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { writeFile, mkdir, copyFile, appendFile, utimes, readFile } from "fs/promises";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { startNextServer, stopNextServer } from "./nextServer";
import { startTempCleanup } from "./tempCleanup";
import { setupAutoUpdate } from "./autoUpdate";
import { drainEvents, recordEvent } from "./eventSpool";

// ──────────────────────────────────────────────────────────────
// Crash capture — registered before anything else can throw.
//
// These are the failures that used to vanish completely: the app dies or
// goes white, the user reopens it, and the only trace is a line in a log
// file on their own disk. recordEvent() writes them to a spool that the
// renderer uploads on its next successful boot (see eventSpool.ts).
//
// Registered at module scope, not inside createWindow(), so a crash
// during startup — the ones users report as "it just doesn't open" — is
// still captured.
// ──────────────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  recordEvent("main.uncaught-exception", err?.message ?? String(err), {
    stack: err?.stack,
  });
  // Deliberately not re-thrown or exited: Electron's default behaviour
  // for an uncaught exception in main is to show a dialog and keep
  // running. Preserving that is better than turning a recoverable error
  // into a hard quit, and the event is on disk either way.
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordEvent("main.unhandled-rejection", err.message, { stack: err.stack });
});

// ──────────────────────────────────────────────────────────────
// Single-instance lock — prevent two Captoras running at once
// (would fight over the temp folder + pick the same port).
// ──────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let stopCleanup: (() => void) | null = null;

app.on("second-instance", () => {
  // User tried to launch a second copy — focus the existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

async function createWindow(): Promise<void> {
  // 1. Spin up the embedded Next.js server first
  let serverUrl: string;
  try {
    const info = await startNextServer();
    serverUrl = info.url;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The single most user-visible failure mode: app opens, shows an
    // error box, quits. Nobody could see how often this happens.
    recordEvent("main.next-server-exited", msg, {
      stack: err instanceof Error ? err.stack : undefined,
      context: { phase: "startup" },
    });
    dialog.showErrorBox(
      "Captora failed to start",
      `Could not boot the embedded server:\n\n${msg}\n\nPlease reinstall Captora.`
    );
    app.quit();
    return;
  }

  // 2. Create the browser window
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0a0a0c",
    show: false, // wait until ready-to-show to avoid flash of empty white
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // need access to fetch from localhost
    },
  });

  // Auto-grant the Local Font Access API permission so the TextPanel's
  // queryLocalFonts() call succeeds without prompting the user. We're
  // inside our own Electron shell — the "local-fonts" capability isn't
  // a privacy concern here; we just want the user's installed font
  // list to show up in the font picker alongside bundled + uploaded
  // fonts.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      // `permission` is typed as a closed union that doesn't yet
      // include "local-fonts" in older @types/electron; cast to
      // `string` for the comparison and accept either spelling
      // Chromium/Electron versions may use.
      const name = permission as string;
      if (name === "local-fonts" || name === "fontAccess") {
        callback(true);
        return;
      }
      // Fall through: deny everything else (default-safe).
      callback(false);
    }
  );

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    // Open DevTools in production too — early-version users will hit
    // bugs and we want them to be able to right-click → Inspect to
    // see the actual error. Toggle off later when stable.
    if (process.env.CAPTORA_OPEN_DEVTOOLS !== "0") {
      mainWindow?.webContents.openDevTools({ mode: "detach" });
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Renderer crash — the "app went white / blank" reports. `reason` is
  // 'crashed' | 'oom' | 'killed' | … ; 'oom' in particular is the
  // signature of the bytes-IPC upload path chewing through memory on a
  // multi-GB source file, which is worth knowing about specifically.
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    recordEvent(
      "main.renderer-gone",
      `Renderer process gone: ${details.reason}`,
      { context: { reason: details.reason, exitCode: details.exitCode } }
    );
  });

  // 3. Load the embedded UI
  await mainWindow.loadURL(serverUrl);

  // 4. Cleanup + auto-update (after the window exists so prompts have a parent)
  stopCleanup = startTempCleanup();
  setupAutoUpdate(() => mainWindow);
}

// ──────────────────────────────────────────────────────────────
// IPC handlers — invoked from preload.ts
// ──────────────────────────────────────────────────────────────

ipcMain.handle("captora:pickMediaFile", async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Select a video or audio file",
    properties: ["openFile"],
    filters: [
      {
        name: "Video / Audio",
        extensions: ["mp4", "mov", "webm", "mkv", "mp3", "wav", "m4a", "aac", "ogg", "flac"],
      },
    ],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("captora:revealInOSFileManager", async (_e, path: string) => {
  shell.showItemInFolder(path);
});

/**
 * Hand the renderer every crash the main process spooled while it had no
 * Supabase session, and clear the spool. The renderer uploads them to
 * `public.app_events` once the user is signed in.
 *
 * Returns [] when there's nothing pending, which is the common case.
 */
ipcMain.handle("captora:drainEvents", async () => {
  const events = drainEvents();
  if (events.length > 0) {
    ipcLog(`drainEvents returning ${events.length} spooled event(s) to renderer`);
  }
  return events;
});

/**
 * Append a single line to captora.log with a timestamp. Used for IPC
 * diagnostics so silent failures are no longer invisible. Sync write
 * because we want the log on disk even if the process crashes
 * immediately after.
 */
function ipcLog(message: string): void {
  try {
    const path = join(app.getPath("userData"), "captora.log");
    appendFile(path, `[ipc ${new Date().toISOString()}] ${message}\n`).catch(
      () => {
        /* swallow — logging must never break the IPC */
      }
    );
  } catch {
    /* userData may not be writable in weird sandbox configs */
  }
}

/**
 * Persist a dropped source video / audio file to the local sessions
 * folder, bypassing Supabase Storage entirely in desktop mode. Called
 * by the renderer during the upload step. Returns the absolute on-disk
 * path so the renderer can pass it through to /api/transcribe.
 *
 * BYTE PATH (saveSourceFile): renderer reads the File into an
 * ArrayBuffer and ships it through IPC's structured clone. Works for
 * any File, but reads the entire file into memory — a 30-min 1080p
 * source can hit 2-3 GB of RAM, OOM-ing the renderer.
 *
 * PATH-COPY (copySourceFile): renderer only sends the source's on-
 * disk path; main does a filesystem-level copy. Constant-memory,
 * fast, handles arbitrary file sizes. Preferred whenever the source
 * came from drag-drop or the native file picker.
 *
 * Both handlers VERIFY the file exists after writing. If verification
 * fails (silent corruption, permission issue, etc.) they throw so the
 * renderer doesn't move on assuming success. Throws also get logged
 * to captora.log so we can see what went wrong post-mortem.
 */
ipcMain.handle(
  "captora:saveSourceFile",
  async (_e, payload: { bytes: Uint8Array; ext: string; projectId: string }) => {
    const sessionsDir = join(app.getPath("userData"), "sessions");
    const filePath = join(sessionsDir, `${payload.projectId}${payload.ext}`);
    ipcLog(
      `saveSourceFile entered projectId=${payload.projectId} ext=${payload.ext} bytes=${payload.bytes.byteLength} target=${filePath}`
    );
    try {
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(filePath, Buffer.from(payload.bytes));
      // Force mtime/atime to now. writeFile sets them automatically
      // but we touch again for parity with the copyFile branch where
      // source mtime would otherwise be inherited.
      const now = new Date();
      await utimes(filePath, now, now);
      // Post-write verification — catches silent failures
      if (!existsSync(filePath)) {
        throw new Error(`writeFile reported success but file is missing: ${filePath}`);
      }
      const size = statSync(filePath).size;
      ipcLog(`saveSourceFile OK size=${size} path=${filePath}`);
      return filePath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ipcLog(`saveSourceFile FAILED ${msg}`);
      throw err;
    }
  }
);

ipcMain.handle(
  "captora:copySourceFile",
  async (
    _e,
    payload: { sourcePath: string; ext: string; projectId: string }
  ) => {
    const sessionsDir = join(app.getPath("userData"), "sessions");
    const destPath = join(sessionsDir, `${payload.projectId}${payload.ext}`);
    ipcLog(
      `copySourceFile entered projectId=${payload.projectId} ext=${payload.ext} src="${payload.sourcePath}" target=${destPath}`
    );
    try {
      if (!payload.sourcePath) {
        throw new Error("copySourceFile: empty sourcePath (webUtils.getPathForFile returned blank)");
      }
      if (!existsSync(payload.sourcePath)) {
        throw new Error(
          `copySourceFile: source path does not exist on disk: ${payload.sourcePath}`
        );
      }
      await mkdir(sessionsDir, { recursive: true });
      await copyFile(payload.sourcePath, destPath);
      // CRITICAL: Node's copyFile preserves the source file's mtime.
      // If the user dropped a video that's days/weeks/months old, the
      // destination ends up with that ancient mtime — and the
      // 12-hour cleanup sweep then sees it as "stale" and deletes it
      // *before* /api/transcribe gets a chance to read it. Force
      // mtime/atime to now so cleanup correctly treats this as a
      // fresh file.
      const now = new Date();
      await utimes(destPath, now, now);
      // Post-copy verification — catches silent corruption
      if (!existsSync(destPath)) {
        throw new Error(`copyFile reported success but file is missing: ${destPath}`);
      }
      const size = statSync(destPath).size;
      ipcLog(`copySourceFile OK size=${size} path=${destPath} (mtime touched)`);
      return destPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ipcLog(`copySourceFile FAILED ${msg}`);
      throw err;
    }
  }
);

/**
 * Read a previously-saved source file back into the renderer when the
 * user reopens a project. Desktop projects skip the Supabase upload, so
 * the file lives only at `<userData>/sessions/<projectId>.<ext>`. This
 * handler resolves that path, reads the bytes, and returns an
 * ArrayBuffer the renderer wraps in a `File` for the editor.
 *
 * Throws if the file is missing — caller surfaces a friendly "Source
 * file is missing" message and asks the user to re-upload.
 */
ipcMain.handle(
  "captora:readSourceFile",
  async (_e, payload: { projectId: string; ext: string }) => {
    const sessionsDir = join(app.getPath("userData"), "sessions");
    const filePath = join(sessionsDir, `${payload.projectId}${payload.ext}`);
    ipcLog(`readSourceFile entered projectId=${payload.projectId} ext=${payload.ext} path=${filePath}`);
    if (!existsSync(filePath)) {
      ipcLog(`readSourceFile MISSING ${filePath}`);
      throw new Error(
        `Source not found at ${filePath}. The file may have been deleted by the cleanup sweep — re-upload to restore.`
      );
    }
    try {
      const bytes = await readFile(filePath);
      ipcLog(`readSourceFile OK size=${bytes.byteLength}`);
      // Return as ArrayBuffer so the renderer can `new File([buf], ...)`
      // without an extra copy. Buffer is a Uint8Array under the hood.
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ipcLog(`readSourceFile FAILED ${msg}`);
      throw err;
    }
  }
);

// ──────────────────────────────────────────────────────────────
// App lifecycle
// ──────────────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  // On macOS apps stay open until Cmd+Q; on Windows/Linux they quit
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  // macOS: clicking the dock icon re-creates the window
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  stopNextServer();
  stopCleanup?.();
});
