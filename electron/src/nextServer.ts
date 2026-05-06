/**
 * Spawns Captora's Next.js standalone server as a child process and
 * waits for it to be ready before resolving. The Electron main process
 * uses the resolved port to load the BrowserWindow.
 *
 * In dev mode (NODE_ENV=development) we don't spawn anything and
 * assume the developer is already running `npm run dev:web` on
 * localhost:3000 — `npm run dev:electron` will just open the window
 * pointing at that.
 *
 * In packaged mode the Next.js standalone bundle is shipped under
 * `<resources>/web/.next/standalone/`. We pass it the env vars that
 * activate desktop-mode behaviour in `/api/transcribe` and `/api/render`:
 *
 *   CAPTORA_MODE=desktop
 *   CAPTORA_SESSIONS_DIR=<userData>/sessions
 *   CAPTORA_RENDERS_DIR=<userData>/renders
 *
 * No code in `web/` knows we're inside Electron — it just sees these
 * env vars and switches paths accordingly.
 */

import { spawn, ChildProcess } from "child_process";
import { mkdir } from "fs/promises";
import { join } from "path";
import { app } from "electron";

const isDev = process.env.NODE_ENV === "development";

let serverProcess: ChildProcess | null = null;

interface ServerInfo {
  port: number;
  url: string;
}

/** Pick an available TCP port ≥ 3100 so we don't fight a user's existing
 *  Next.js dev server on 3000. Falls back through 50 ports before giving up. */
async function findFreePort(start = 3100): Promise<number> {
  const net = await import("net");
  for (let port = start; port < start + 50; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("No free port in 3100..3149");
}

export async function startNextServer(): Promise<ServerInfo> {
  // Dev mode: developer is running `npm run dev:web` separately. Skip
  // spawning anything; just point the window at their dev server.
  if (isDev) {
    return { port: 3000, url: "http://127.0.0.1:3000" };
  }

  const userData = app.getPath("userData");
  const sessionsDir = join(userData, "sessions");
  const rendersDir = join(userData, "renders");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(rendersDir, { recursive: true });

  const port = await findFreePort();
  const standaloneDir = join(
    process.resourcesPath,
    "web",
    ".next",
    "standalone"
  );
  const serverScript = join(standaloneDir, "web", "server.js");

  console.log(`[nextServer] spawning ${serverScript} on port ${port}`);

  serverProcess = spawn(process.execPath, [serverScript], {
    cwd: standaloneDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      // Desktop-mode flags consumed by web/src/lib/captora-mode.ts
      CAPTORA_MODE: "desktop",
      CAPTORA_SESSIONS_DIR: sessionsDir,
      CAPTORA_RENDERS_DIR: rendersDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[next] ${chunk}`);
  });
  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[next-err] ${chunk}`);
  });

  // Wait for the "Ready" line on stdout — Next.js prints it once it's
  // listening. 30s timeout; first launch can be slow on cold disk.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Next.js failed to start within 30s"));
    }, 30_000);

    serverProcess?.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().toLowerCase().includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    serverProcess?.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    serverProcess?.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Next.js exited early with code ${code}`));
    });
  });

  return { port, url: `http://127.0.0.1:${port}` };
}

/** Kill the embedded Next.js server. Called on app quit so the process
 *  doesn't linger after the window closes. */
export function stopNextServer(): void {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}
