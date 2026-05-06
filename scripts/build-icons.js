#!/usr/bin/env node
/**
 * Generate icon.ico (Windows) + icon.icns (Mac) from a single
 * 1024×1024 source PNG. Run once after replacing
 * `resources/icon.png`; the outputs are committed alongside it so
 * the GitHub Actions runners can build installers without needing
 * platform-specific imagemagick/sips installs.
 *
 * Usage:
 *   node scripts/build-icons.js
 *
 * Reads:   resources/icon.png  (1024×1024)
 * Writes:  resources/icon.ico  (multi-size 16/24/32/48/64/128/256)
 *          resources/icon.icns (multi-size 16…1024 retina pairs)
 */

const fs = require("fs");
const path = require("path");
const png2icons = require("png2icons");

const RESOURCES = path.join(__dirname, "..", "resources");
const SOURCE = path.join(RESOURCES, "icon.png");
const ICO_OUT = path.join(RESOURCES, "icon.ico");
const ICNS_OUT = path.join(RESOURCES, "icon.icns");

if (!fs.existsSync(SOURCE)) {
  console.error(`✗ Source not found: ${SOURCE}`);
  console.error(
    "  Save your 1024×1024 logo PNG as `resources/icon.png` and re-run."
  );
  process.exit(1);
}

const png = fs.readFileSync(SOURCE);

// png2icons.BICUBIC = sharpest resize at small sizes; alternatives are
// HERMITE / BEZIER / BILINEAR. The "sharper at 16×16" matters because
// that's the size users see in the Windows taskbar / Mac dock.
const ico = png2icons.createICO(png, png2icons.BICUBIC, 0, false, true);
const icns = png2icons.createICNS(png, png2icons.BICUBIC, 0);

if (!ico) {
  console.error("✗ ICO generation failed (input may not be a valid PNG)");
  process.exit(2);
}
if (!icns) {
  console.error("✗ ICNS generation failed");
  process.exit(2);
}

fs.writeFileSync(ICO_OUT, ico);
fs.writeFileSync(ICNS_OUT, icns);

const sizeKb = (b) => `${Math.round(b.length / 1024)} KB`;
console.log(`✓ Wrote ${path.relative(process.cwd(), ICO_OUT)}  (${sizeKb(ico)})`);
console.log(`✓ Wrote ${path.relative(process.cwd(), ICNS_OUT)} (${sizeKb(icns)})`);
