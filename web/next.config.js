// Single source of truth for the app version: the root package.json that
// electron-builder also reads. Inlined into the client bundle below so
// crash reports say which build they came from — a report you can't tie
// to a version tells you a bug exists but not whether you already fixed it.
const APP_VERSION = require("../package.json").version;

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
  // `output: "standalone"` produces a self-contained `.next/standalone/`
  // folder with `server.js` + the minimal `node_modules` Next needs to
  // run. The Electron main process spawns this exact `server.js` to
  // embed the app inside the desktop wrapper. Has zero effect on a
  // normal `next dev` / `next start` web deploy — the standalone
  // bundle just sits alongside the regular build output.
  output: "standalone",
  // Strict mode double-mounts components in dev to surface side-effect bugs.
  // That kills our blob-URL audio: createObjectURL on first mount → revoke
  // on simulated unmount → second mount creates a new URL but the loaded
  // audio element still references the revoked one → silent. Off in dev.
  reactStrictMode: false,
  // The `@captora/remotion` workspace ships raw .tsx so the Player can render
  // the same compositions used by the renderer. Tell Next.js to transpile it.
  transpilePackages: ["@captora/remotion"],
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
    // /api/transcribe and /api/render now receive only small JSON
    // envelopes — the source media goes browser → Supabase Storage
    // directly, then the server downloads from Storage. This sidesteps
    // the gigabyte multipart parsing bugs (`expected CRLF`, `expected
    // boundary after body`) that hit Next.js's dev server above ~1GB.
    // 50MB on the JSON path is plenty for the body + base64 thumbnail.
    middlewareClientMaxBodySize: "50mb",
  },
  // transformers.js + onnxruntime-node ship native bindings; let them
  // load via require() at runtime instead of being webpack-bundled.
  serverExternalPackages: [
    "@huggingface/transformers",
    "onnxruntime-node",
    "sharp",
    "ffmpeg-static",
    "@remotion/bundler",
    "@remotion/renderer",
    "remotion",
  ],
  // Force the standalone tracer to bundle Remotion's runtime deep
  // dependencies. `serverExternalPackages` keeps them as require()'d
  // modules at runtime, but the tracer still skips packages that are
  // only loaded via `import("...")` strings inside @remotion/bundler
  // (esbuild plugins, execa, react-dom). Without these include rules
  // the packaged build hits MODULE_NOT_FOUND mid-render.
  outputFileTracingIncludes: {
    "/api/render": [
      "../node_modules/remotion/**",
      "../node_modules/@remotion/**",
      "../node_modules/esbuild/**",
      "../node_modules/@esbuild/**",
      "../node_modules/execa/**",
      "../node_modules/cross-spawn/**",
      "../node_modules/which/**",
      "../node_modules/get-stream/**",
      "../node_modules/human-signals/**",
      "../node_modules/is-stream/**",
      "../node_modules/merge-stream/**",
      "../node_modules/npm-run-path/**",
      "../node_modules/onetime/**",
      "../node_modules/mimic-fn/**",
      "../node_modules/signal-exit/**",
      "../node_modules/strip-final-newline/**",
      "../node_modules/path-key/**",
      "../node_modules/shebang-command/**",
      "../node_modules/shebang-regex/**",
      "../node_modules/isexe/**",
      "../node_modules/ffmpeg-static/**",
      // extract-zip is loaded by @remotion/renderer at runtime to unpack
      // the Chromium binary on first render. Without it the route throws
      // ERR_MODULE_NOT_FOUND at render start — confirmed in production
      // on a Windows v1.0.27 install where every render attempt failed
      // with 500. Same family as the execa / @remotion/bundler tracer
      // gaps we already patched; the tracer can't see dynamically
      // imported modules so we have to force-include them + their
      // transitive deps.
      "../node_modules/extract-zip/**",
      "../node_modules/yauzl/**",
      "../node_modules/buffer-crc32/**",
      "../node_modules/fd-slicer/**",
      "../node_modules/pend/**",
      "../node_modules/debug/**",
      "../node_modules/ms/**",
      // pump + chain — extract-zip's nested get-stream pulls these in
      // for the stream piping during Chromium binary unpack. v1.0.29
      // added extract-zip but `pump` was the next link missing.
      "../node_modules/pump/**",
      "../node_modules/end-of-stream/**",
      "../node_modules/once/**",
      "../node_modules/wrappy/**",
      "../node_modules/inherits/**",
      "../node_modules/mkdirp/**",
      // React + ReactDOM full packages — Remotion's esbuild bundle()
      // imports react-dom/client (createRoot) at composition build time.
      // Next.js tracer ships only the subpaths the web app uses
      // (react-dom/server etc.), so client.js was missing in v1.0.31.
      // Force-include the whole packages plus scheduler (React's own
      // transitive).
      "../node_modules/react/**",
      "../node_modules/react-dom/**",
      "../node_modules/scheduler/**",
    ],
    "/api/transcribe": [
      // ffmpeg-static ships a native binary used for audio extraction
      // before cloud STT (audio-extract.ts) and for local CPU Whisper's
      // PCM decoding (whisper.ts). The tracer misses the binary on Mac
      // because it's not a JS require target — force-include the whole
      // package so the executable lands in standalone.
      "../node_modules/ffmpeg-static/**",
    ],
  },
};

module.exports = nextConfig;
