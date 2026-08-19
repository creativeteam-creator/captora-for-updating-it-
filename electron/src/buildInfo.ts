/**
 * Build-time facts baked into the packaged app.
 *
 * electron-builder's `extraMetadata` merges extra keys into the packaged
 * app's package.json (see electron-builder.config.js). We read them back
 * here so runtime code can branch on how the build was produced —
 * specifically whether it carries a real code signature.
 *
 * Why this exists: autoUpdate.ts historically hard-disabled Windows
 * signature verification and hard-bypassed Squirrel.Mac, because our
 * builds are ad-hoc signed. Those bypasses are the right call for an
 * unsigned build and exactly the wrong call for a signed one — they'd
 * throw away the security guarantee the certificate was bought for. This
 * module lets the updater ask "am I a signed build?" instead of assuming.
 */

import { app } from "electron";
import { readFileSync } from "fs";
import { join } from "path";

interface PackagedMetadata {
  captoraSigned?: boolean;
}

let cached: PackagedMetadata | null = null;

function readPackagedMetadata(): PackagedMetadata {
  if (cached) return cached;
  try {
    // app.getAppPath() points at the app bundle root (app.asar, or the
    // unpacked app/ folder in dev). package.json sits at its top level.
    const raw = readFileSync(join(app.getAppPath(), "package.json"), "utf8");
    cached = JSON.parse(raw) as PackagedMetadata;
  } catch {
    // Dev runs and odd packaging layouts land here. Treating that as
    // "unsigned" is the safe default: the updater keeps its bypasses,
    // which is the behaviour that works today.
    cached = {};
  }
  return cached;
}

/**
 * True when this build was produced with a real signing certificate
 * (Developer ID on Mac, Authenticode / Azure Trusted Signing on Windows).
 *
 * Flipped on automatically by electron-builder.config.js the first time a
 * release runs with the signing secrets present — no code change needed.
 */
export function isSignedBuild(): boolean {
  return readPackagedMetadata().captoraSigned === true;
}
