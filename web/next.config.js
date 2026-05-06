/** @type {import('next').NextConfig} */
const nextConfig = {
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
  ],
};

module.exports = nextConfig;
