/**
 * electron-builder configuration.
 *
 * Moved out of package.json's `build` field so it can branch on
 * environment variables. The whole point: **the same config produces an
 * unsigned build today and a fully signed + notarized build the moment
 * signing secrets exist in the CI vault** — no config edit, no release
 * checklist step to forget.
 *
 * ── Signing switches ────────────────────────────────────────────────────
 *
 * macOS — set these repo secrets to turn on real signing:
 *   CSC_LINK                     base64 .p12 (Developer ID Application cert)
 *   CSC_KEY_PASSWORD             password for that .p12
 *   APPLE_ID                     Apple account email        ┐ all three
 *   APPLE_APP_SPECIFIC_PASSWORD  app-specific password      ├ required for
 *   APPLE_TEAM_ID                10-char team ID            ┘ notarization
 *
 * Windows — pick ONE of:
 *   (a) Traditional cert:
 *       WIN_CSC_LINK             base64 .pfx
 *       WIN_CSC_KEY_PASSWORD     password for that .pfx
 *   (b) Azure Trusted Signing (cheapest modern option, ~$10/mo):
 *       AZURE_TRUSTED_SIGNING_ENDPOINT      e.g. https://eus.codesigning.azure.net
 *       AZURE_TRUSTED_SIGNING_ACCOUNT       account name
 *       AZURE_TRUSTED_SIGNING_PROFILE       certificate profile name
 *       AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET
 *
 * What flips when signing is on:
 *   - mac:  identity is resolved from the cert (instead of forced null),
 *           hardenedRuntime turns on with the entitlements below, and the
 *           build is submitted to Apple's notary service.
 *   - both: `captoraSigned: true` is baked into the packaged app's
 *           package.json. electron/src/buildInfo.ts reads that flag and
 *           electron/src/autoUpdate.ts uses it to decide whether to trust
 *           the platform's own signature verification (signed builds) or
 *           fall back to the bypass workarounds (unsigned builds).
 *
 * Nothing here throws when the secrets are absent — that's the current,
 * supported, unsigned path.
 */

// ── macOS ────────────────────────────────────────────────────────────────
const macCertPresent = Boolean(process.env.CSC_LINK);
const macNotarizeReady = Boolean(
  process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID
);

// ── Windows ──────────────────────────────────────────────────────────────
const winCertPresent = Boolean(process.env.WIN_CSC_LINK);
const winAzurePresent = Boolean(
  process.env.AZURE_TRUSTED_SIGNING_ENDPOINT &&
    process.env.AZURE_TRUSTED_SIGNING_ACCOUNT &&
    process.env.AZURE_TRUSTED_SIGNING_PROFILE
);
const winSigned = winCertPresent || winAzurePresent;

/**
 * True when THIS build will carry a real, verifiable signature. Baked
 * into the app so the updater can pick the right install strategy at
 * runtime. Each CI runner builds one platform, so a single flag is
 * unambiguous.
 */
const signed =
  process.platform === "darwin" ? macCertPresent : process.platform === "win32" ? winSigned : false;

// Log the resolved posture — CI logs then answer "why is this build
// unsigned?" without anyone having to reverse-engineer the env.
console.log(
  `[electron-builder.config] platform=${process.platform} signed=${signed} ` +
    `(macCert=${macCertPresent} macNotarize=${macNotarizeReady} ` +
    `winCert=${winCertPresent} winAzure=${winAzurePresent})`
);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.qhtclinic.captora",
  productName: "Captora",
  copyright: "© 2025 QHT Clinic",

  // Baked into the packaged app's package.json — read back at runtime by
  // electron/src/buildInfo.ts.
  extraMetadata: {
    captoraSigned: signed,
  },

  directories: {
    output: "dist-electron",
    buildResources: "resources",
  },

  files: [
    "electron/dist/**/*",
    "electron/package.json",
    "!**/node_modules/**/{CHANGELOG.md,README.md,readme.md,*.d.ts.map,*.js.map}",
    "!**/node_modules/**/{test,tests,__tests__,powered-test,example,examples}",
    "!**/node_modules/.cache",
  ],

  extraResources: [
    { from: "web/.next/standalone", to: "web/.next/standalone" },
    { from: "web/.next/static", to: "web/.next/standalone/web/.next/static" },
    { from: "web/.env.production", to: "web/.env.production" },
    { from: "scripts", to: "scripts" },
  ],

  // ── Windows ────────────────────────────────────────────────────────────
  // x64 only, deliberately. Remotion 4.0.x ships no `@remotion/compositor-
  // win32-arm64` package — a native ARM64 build would install fine and then
  // fail at export with a missing-compositor error. Windows 11 on ARM runs
  // the x64 build under emulation, including the x64 compositor, so ARM
  // users are already covered by this same installer.
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "resources/icon.ico",
    publisherName: "QHT Clinic",
    ...(winAzurePresent
      ? {
          azureSignOptions: {
            endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
            codeSigningAccountName: process.env.AZURE_TRUSTED_SIGNING_ACCOUNT,
            certificateProfileName: process.env.AZURE_TRUSTED_SIGNING_PROFILE,
          },
        }
      : {}),
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
  },

  // ── macOS ──────────────────────────────────────────────────────────────
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    icon: "resources/icon.icns",
    category: "public.app-category.video",
    // Unsigned path: force ad-hoc (identity null) and keep the hardened
    // runtime off — it requires a real Developer ID cert to be useful.
    // Signed path: OMIT `identity` entirely so electron-builder resolves
    // it from CSC_LINK / CSC_NAME, and enable the hardened runtime, which
    // notarization requires.
    //
    // The key is spread in rather than set to `undefined`: the schema
    // types `identity` as ["null","string"], and an explicit undefined is
    // a needless bet on how the validator treats own-but-undefined
    // properties. Absent is unambiguous.
    ...(macCertPresent ? {} : { identity: null }),
    hardenedRuntime: macCertPresent,
    gatekeeperAssess: false,
    type: "distribution",
    ...(macCertPresent
      ? {
          entitlements: "resources/entitlements.mac.plist",
          entitlementsInherit: "resources/entitlements.mac.plist",
        }
      : {}),
    // electron-builder 25 notarizes via notarytool using APPLE_ID +
    // APPLE_APP_SPECIFIC_PASSWORD from the environment. Explicit `false`
    // when we can't notarize keeps the build from stalling on a lookup.
    notarize: macNotarizeReady ? { teamId: process.env.APPLE_TEAM_ID } : false,
  },

  dmg: {
    writeUpdateInfo: true,
    sign: macCertPresent,
  },

  // ── Linux ──────────────────────────────────────────────────────────────
  // x64 only: @remotion/compositor-linux-x64-gnu is what the CI runner
  // installs natively. AppImage is the portable "just run it" artifact and
  // is the only Linux target electron-updater can auto-update; .deb covers
  // Debian/Ubuntu users who want a real package.
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    icon: "resources/icon.png",
    category: "AudioVideo",
    maintainer: "QHT Clinic <creativeteam@qhtclinic.com>",
    synopsis: "Viral-style auto-captions for video and audio",
    description:
      "Captora transcribes your video or audio and renders animated, viral-style captions onto it.",
  },

  publish: {
    provider: "github",
    owner: "creativeteam-creator",
    repo: "captora-for-updating-it-",
    private: false,
    releaseType: "release",
  },
};
