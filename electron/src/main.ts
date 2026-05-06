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
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { startNextServer, stopNextServer } from "./nextServer";
import { startTempCleanup } from "./tempCleanup";
import { setupAutoUpdate } from "./autoUpdate";

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
 * Persist a dropped source video / audio file to the local sessions
 * folder, bypassing Supabase Storage entirely in desktop mode. Called
 * by the renderer during the upload step. Returns the absolute on-disk
 * path so the renderer can pass it through to /api/transcribe.
 *
 * Buffer is sent as a Uint8Array via IPC's structured clone (Electron
 * handles large transfers natively without base64 overhead).
 */
ipcMain.handle(
  "captora:saveSourceFile",
  async (_e, payload: { bytes: Uint8Array; ext: string; projectId: string }) => {
    const sessionsDir = join(app.getPath("userData"), "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const filePath = join(sessionsDir, `${payload.projectId}${payload.ext}`);
    await writeFile(filePath, Buffer.from(payload.bytes));
    return filePath;
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
