#!/usr/bin/env node

/**
 * Auto-stage every transitive dependency Remotion's bundler / renderer
 * needs at render time. Replaces the manual whack-a-mole list of
 * package names in next.config.js + release.yml — every Remotion
 * version bump used to leak a new missing module (extract-zip → pump →
 * style-loader → …), each one requiring a new release.
 *
 * Algorithm (BFS):
 *   1. Seed the queue with @remotion/bundler, @remotion/renderer,
 *      @remotion/studio-shared, and the bare `remotion` package.
 *   2. For every package in the queue:
 *        a. Walk its `dist/` (or whole package root if no dist) and
 *           regex-extract every require("…") / import("…") / from "…"
 *           module name.
 *        b. Read its package.json and pull every entry in
 *           dependencies + non-optional peerDependencies.
 *      Combine → enqueue any unseen package names.
 *   3. After the queue drains, every package in `visited` gets copied
 *      from <repo>/node_modules into the standalone
 *      node_modules tree.
 *
 * Run from the repo root, AFTER `npm run build:web`:
 *   node scripts/stage-remotion-deps.js
 *
 * Idempotent — re-running is a no-op (the destination check skips
 * already-copied packages).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const STANDALONE_NM = path.join(
  REPO_ROOT,
  "web",
  ".next",
  "standalone",
  "node_modules"
);

const SCAN_SEEDS = [
  "@remotion/bundler",
  "@remotion/renderer",
  "@remotion/studio-shared",
  "@remotion/compositor-darwin-arm64",
  "@remotion/compositor-darwin-x64",
  "@remotion/compositor-win32-x64",
  "@remotion/compositor-linux-x64",
  "remotion",
];

// Node built-ins — never copyable, always skip
const BUILTINS = new Set([
  "fs", "path", "os", "child_process", "stream", "events", "util", "url",
  "http", "https", "net", "tls", "crypto", "buffer", "zlib", "querystring",
  "string_decoder", "assert", "tty", "vm", "worker_threads", "process",
  "module", "perf_hooks", "constants", "readline", "dns", "dgram", "v8",
  "async_hooks", "inspector", "punycode", "timers", "trace_events",
  "fs/promises", "stream/promises", "stream/web", "stream/consumers",
  "node:fs", "node:path", "node:os", "node:child_process", "node:stream",
  "node:events", "node:util", "node:url", "node:http", "node:https",
  "node:net", "node:tls", "node:crypto", "node:buffer", "node:zlib",
  "node:querystring", "node:assert", "node:tty", "node:vm", "node:worker_threads",
  "node:process", "node:module", "node:perf_hooks", "node:fs/promises",
  "node:async_hooks", "node:inspector", "node:string_decoder",
]);

const IMPORT_PATTERNS = [
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+(?:[^'"`]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  // require.resolve("name") — Remotion uses this for runtime loader lookup
  /\brequire\.resolve\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Walk a directory recursively, returning all .js / .mjs / .cjs files
 * (the file types we need to scan for import strings).
 *
 * Nested `node_modules` ARE scanned — those folders pin specific
 * versions of transitives (e.g. extract-zip/node_modules/get-stream
 * is an older get-stream that requires `pump`, while the top-level
 * get-stream does not). Their imports surface names we must enqueue
 * to the root-level resolution; we don't stage from inside them, so
 * scanning costs nothing and prevents missed deps.
 */
function listJsFiles(dir, acc) {
  acc = acc || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".bin") continue; // not a real package dir
      listJsFiles(full, acc);
    } else if (e.isFile()) {
      if (/\.(c?js|mjs)$/.test(e.name)) acc.push(full);
    }
  }
  return acc;
}

/**
 * Extract bare package names (no relative paths, no built-ins) from
 * a chunk of JS source.
 */
function extractPackageNames(code) {
  const names = new Set();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) {
      const spec = m[1];
      if (!spec) continue;
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (BUILTINS.has(spec)) continue;
      // Strip subpath — keep package name only
      // "@scope/pkg/sub/path" → "@scope/pkg"
      // "pkg/sub" → "pkg"
      const parts = spec.split("/");
      const pkg = spec.startsWith("@") && parts.length >= 2
        ? parts.slice(0, 2).join("/")
        : parts[0];
      if (BUILTINS.has(pkg)) continue;
      names.add(pkg);
    }
  }
  return names;
}

/**
 * Read a package's package.json and return every declared production
 * dependency (deps + non-optional peers). Falls back to [] if the
 * package isn't installed or has no manifest.
 */
function getDeclaredDeps(pkgName) {
  const pkgJsonPath = path.join(NODE_MODULES, pkgName, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return [];
  }
  const out = [];
  if (manifest.dependencies) out.push(...Object.keys(manifest.dependencies));
  if (manifest.peerDependencies) {
    const optional = manifest.peerDependenciesMeta || {};
    for (const name of Object.keys(manifest.peerDependencies)) {
      if (optional[name] && optional[name].optional) continue;
      out.push(name);
    }
  }
  return out;
}

/**
 * Discover the full transitive set of packages every seed package
 * pulls in. Combines scan-based discovery (require/import strings
 * inside the source) and manifest-based discovery (declared deps).
 */
function discoverAll(seeds) {
  const visited = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const pkg = queue.shift();
    if (visited.has(pkg)) continue;
    visited.add(pkg);
    const pkgDir = path.join(NODE_MODULES, pkg);
    if (!fs.existsSync(pkgDir)) continue;

    // Scan source for runtime require/import strings
    const files = listJsFiles(pkgDir);
    for (const file of files) {
      let code;
      try {
        code = fs.readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      for (const name of extractPackageNames(code)) {
        if (!visited.has(name)) queue.push(name);
      }
    }

    // Pull declared deps too — catches loaders / plugins listed in
    // package.json but not appearing in any require() string (Remotion
    // resolves them by name via webpack/rspack loader spec).
    for (const dep of getDeclaredDeps(pkg)) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return visited;
}

/**
 * Copy a package directory into the standalone node_modules tree.
 * Uses Node's recursive cp with `force: false` so previously-staged
 * files (e.g. ones Next.js's tracer already placed) stay put.
 */
function stagePackage(pkgName) {
  const src = path.join(NODE_MODULES, pkgName);
  const dst = path.join(STANDALONE_NM, pkgName);
  if (!fs.existsSync(src)) return { staged: false, reason: "not-installed" };
  if (fs.existsSync(dst)) return { staged: false, reason: "already-staged" };
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, errorOnExist: false });
  return { staged: true };
}

function main() {
  console.log(`[stage-remotion-deps] starting from ${SCAN_SEEDS.length} seed packages`);
  console.log(`[stage-remotion-deps] node_modules: ${NODE_MODULES}`);
  console.log(`[stage-remotion-deps] standalone:   ${STANDALONE_NM}`);

  if (!fs.existsSync(STANDALONE_NM)) {
    console.error(`[stage-remotion-deps] standalone path does not exist — run 'npm run build:web' first`);
    process.exit(1);
  }

  const all = discoverAll(SCAN_SEEDS);
  console.log(`[stage-remotion-deps] discovered ${all.size} transitive packages`);

  let staged = 0;
  let already = 0;
  let missing = 0;
  for (const pkg of all) {
    const r = stagePackage(pkg);
    if (r.staged) staged++;
    else if (r.reason === "already-staged") already++;
    else if (r.reason === "not-installed") missing++;
  }

  console.log(
    `[stage-remotion-deps] done — staged=${staged} already=${already} ` +
    `not-installed=${missing} (not-installed packages are usually optional ` +
    `platform-specific siblings like @esbuild/linux-arm64 on a darwin runner)`
  );
}

main();
