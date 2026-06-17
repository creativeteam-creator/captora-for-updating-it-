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

import { app, BrowserWindow, dialog, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { exec } from "child_process";
import { appendFileSync } from "fs";
import { join } from "path";

const GITHUB_RELEASE_BASE =
  "https://github.com/creativeteam-creator/captora-for-updating-it-/releases/download";

let bound = false;

/**
 * Echo autoUpdate progress to BOTH the Electron main-process stdout AND
 * the captora.log file in userData. The log file was previously only
 * written by nextServer.ts (it pipes the Next.js subprocess stdout/err
 * to disk), so anything we console.log from the main process never
 * landed in the file. That's why old debugging sessions saw zero
 * `[autoUpdate]` lines even when the updater was firing.
 */
function logLine(message: string): void {
  console.log(message);
  try {
    const path = join(app.getPath("userData"), "captora.log");
    appendFileSync(path, `[main] ${message}\n`);
  } catch {
    // userData may not be writable in weird sandbox configs — drop silently
  }
}

export function setupAutoUpdate(getMainWindow: () => BrowserWindow | null): void {
  if (bound) return;
  bound = true;

  if (process.env.NODE_ENV === "development") {
    logLine("[autoUpdate] disabled in development");
    return;
  }

  // Match electron-builder's defaults — pulls the publish config from
  // the packaged app's app-update.yml
  autoUpdater.autoDownload = true;       // background download
  autoUpdater.autoInstallOnAppQuit = true;

  // ── Mac-specific: degrade to popup-and-download ───────────────────────
  // Squirrel.Mac (electron-updater's Mac install backend) verifies the
  // downloaded .app's code signature against the running app's signature
  // before swap. Our ad-hoc-signed builds use a fresh random certificate
  // per build (no $99/year Apple Developer cert), so the swap is rejected:
  //   "Code signature at URL ... did not pass validation: code has no
  //    resources but signature indicates they must be present"
  // The download succeeds but the install silently fails — user clicks
  // "Restart" and ends up on the same old version.
  //
  // Workaround: skip Squirrel.Mac entirely. When an update is available
  // on Mac, show a popup that opens the GitHub release .dmg URL in the
  // user's browser. They drag-drop install. Less seamless than Windows
  // but 100% reliable until we ship a properly-signed-and-notarized
  // build.
  if (process.platform === "darwin") {
    autoUpdater.autoDownload = false;       // download wastes bandwidth if install will fail
    autoUpdater.autoInstallOnAppQuit = false;
  }

  // Skip Windows code-signing verification. We ship ad-hoc-signed builds
  // (no $300/year EV cert), so the new installer's Authenticode signature
  // is null and electron-updater's default verifier refuses to install
  // it ("New version X.Y.Z is not signed by the application owner").
  // The download itself is fetched over HTTPS straight from our own
  // GitHub release — that's the trust anchor here, not a cert chain.
  // Also enable disableWebInstaller per the upstream warning so this
  // path keeps working when electron-updater changes the default in a
  // future release.
  type NsisUpdaterOverrides = {
    disableWebInstaller?: boolean;
    verifyUpdateCodeSignature?: (
      publisherNames: string[],
      unescapedTempUpdateFile: string
    ) => Promise<string | null>;
  };
  const win32Updater = autoUpdater as unknown as NsisUpdaterOverrides;
  if (process.platform === "win32") {
    win32Updater.verifyUpdateCodeSignature = async () => null;
    win32Updater.disableWebInstaller = true;
  }

  // Pipe electron-updater's own internal log through our log file too —
  // surfaces network errors, manifest parse failures, GitHub rate limits,
  // and other rare failure modes that don't fire as events.
  type ElectronUpdaterLogger = {
    transports?: { file?: { level?: string | false } };
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
  const updaterLogger: ElectronUpdaterLogger = {
    info: (m) => logLine(`[autoUpdate:info] ${m}`),
    warn: (m) => logLine(`[autoUpdate:warn] ${m}`),
    error: (m) => logLine(`[autoUpdate:error] ${m}`),
  };
  (autoUpdater as unknown as { logger: ElectronUpdaterLogger }).logger = updaterLogger;

  logLine(`[autoUpdate] setup — currentVersion=${app.getVersion()} feedURL=github`);

  autoUpdater.on("checking-for-update", () => {
    logLine("[autoUpdate] checking…");
  });

  autoUpdater.on("update-available", async (info) => {
    logLine(`[autoUpdate] update available: v${info.version}`);

    // Mac: show a popup that opens the .dmg URL in the user's browser
    // instead of trying to install via Squirrel.Mac (which fails on our
    // ad-hoc signatures — see the autoDownload=false block above).
    if (process.platform === "darwin") {
      const win = getMainWindow();
      if (!win) return;
      const result = await dialog.showMessageBox(win, {
        type: "info",
        buttons: ["Download", "Later"],
        defaultId: 0,
        title: "Captora update available",
        message: `Captora ${info.version} is available.`,
        detail:
          "Click Download to open the .dmg in your browser. Mount it, drag the new Captora into Applications, and replace the existing copy. Your work is saved.",
      });
      if (result.response !== 0) return;
      // Pick the right .dmg for this user's CPU. Apple Silicon Macs
      // report process.arch === "arm64"; Intel report "x64".
      const dmgName =
        process.arch === "arm64"
          ? `Captora-${info.version}-arm64.dmg`
          : `Captora-${info.version}.dmg`;
      const url = `${GITHUB_RELEASE_BASE}/v${info.version}/${dmgName}`;
      logLine(`[autoUpdate] opening download URL: ${url}`);
      void shell.openExternal(url);
    }
  });

  autoUpdater.on("update-not-available", () => {
    logLine("[autoUpdate] up to date");
  });

  autoUpdater.on("error", (err) => {
    logLine(`[autoUpdate] error: ${err.message}`);
  });

  autoUpdater.on("download-progress", (p) => {
    logLine(`[autoUpdate] downloading: ${p.percent.toFixed(1)}%`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    logLine(`[autoUpdate] downloaded v${info.version}`);

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
      logLine(`[autoUpdate] check failed: ${err.message}`);
    });
  }, 3_000);

  // Re-check every 4 hours while the app stays open
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logLine(`[autoUpdate] periodic check failed: ${err.message}`);
    });
  }, 4 * 60 * 60 * 1000);
}
