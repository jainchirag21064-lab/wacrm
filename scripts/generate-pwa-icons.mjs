/**
 * Generate PWA icons for the manifest.
 *
 * Creates 192×192 and 512×512 PNG icons matching the brand mark
 * (WaPilot brand-green rounded square + white chat bubble glyph).
 *
 * Run via: node scripts/generate-pwa-icons.mjs
 * (Also executed automatically by `npm run build`.)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const ICONS_DIR = join(PUBLIC_DIR, "icons");

const BRAND_GREEN = "#0f7a46";
const WHITE = "#ffffff";
const SIZES = [192, 512];

function createIconSVG(size) {
  const padding = Math.round(size * 0.2);
  const cornerRadius = Math.round(size * 0.15);
  const inner = size - padding * 2;
  const strokeW = Math.max(2, Math.round(size * 0.04));
  const iconScale = inner / 64;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${cornerRadius}" fill="${BRAND_GREEN}"/>
  <g transform="translate(${padding} ${padding})">
    <svg width="${inner}" height="${inner}" viewBox="0 0 24 24" fill="none"
         stroke="${WHITE}" stroke-width="${(strokeW / iconScale).toFixed(2)}"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  </g>
</svg>`;
}

async function main() {
  await mkdir(ICONS_DIR, { recursive: true });

  for (const size of SIZES) {
    const svg = createIconSVG(size);
    const png = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
    const outPath = join(ICONS_DIR, `icon-${size}.png`);
    await writeFile(outPath, png);
    console.log(`✓ ${outPath}`);
  }

  console.log("PWA icons generated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
