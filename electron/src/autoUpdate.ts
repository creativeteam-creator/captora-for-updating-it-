/**
 * Auto-update flow via electron-updater + GitHub Releases.
 *
 * Publisher side:
 *   1. Bump version in root package.json
 *   2. `git tag v1.x.y && git push --tags`
 *   3. GitHub Actions builds + publishes to GitHub Releases
 *
 * Client side (this file):
 *   1. 3 seconds after launch, check GitHub for newer version
 *   2. If found, download in background while user works
 *   3. When ready, prompt user — they choose when to restart
 *   4. On restart, the new binary takes over
 *
 * Free Mac path: post-update we strip the `com.apple.quarantine`
 * extended attribute on the new .app bundle so Gatekeeper doesn't
 * block the next launch with "developer cannot be verified". Without
 * this, ad-hoc-signed builds re-prompt the user on every update.
 *
 * Disabled in dev (NODE_ENV=development) — no point checking for
 * updates against an installed binary that doesn't exist.
 */

import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { exec } from "child_process";

let bound = false;

export function setupAutoUpdate(getMainWindow: () => BrowserWindow | null): void {
  if (bound) return;
  bound = true;

  if (process.env.NODE_ENV === "development") {
    console.log("[autoUpdate] disabled in development");
    return;
  }

  // Match electron-builder's defaults — pulls the publish config from
  // the packaged app's app-update.yml
  autoUpdater.autoDownload = true;       // background download
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[autoUpdate] checking…");
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[autoUpdate] update available: v${info.version}`);
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[autoUpdate] up to date");
  });

  autoUpdater.on("error", (err) => {
    console.warn("[autoUpdate] error:", err.message);
  });

  autoUpdater.on("download-progress", (p) => {
    console.log(`[autoUpdate] downloading: ${p.percent.toFixed(1)}%`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    console.log(`[autoUpdate] downloaded v${info.version}`);

    // Mac-specific: strip quarantine on the new app bundle so the
    // first launch after restart doesn't trigger Gatekeeper. Only
    // matters for the free ad-hoc-signed path; signed-and-notarized
    // builds don't need this. Best-effort — failure just means the
    // user sees the prompt once.
    if (process.platform === "darwin") {
      const appPath = app.getAppPath().replace(/\/Contents\/.*$/, "");
      try {
        await new Promise<void>((resolve) => {
          exec(`xattr -dr com.apple.quarantine "${appPath}"`, () => resolve());
        });
      } catch {
        /* ignore — non-critical */
      }
    }

    const win = getMainWindow();
    if (!win) {
      // No window to prompt against; install on next quit
      return;
    }

    const result = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      title: "Captora update ready",
      message: `Captora ${info.version} downloaded.`,
      detail:
        "Restart the app to apply the update. Your work is saved automatically.",
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  // Stagger the first check so the app finishes booting first.
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn("[autoUpdate] check failed:", err.message);
    });
  }, 3_000);

  // Re-check every 4 hours while the app stays open
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[autoUpdate] periodic check failed:", err.message);
    });
  }, 4 * 60 * 60 * 1000);
}
