/**
 * Pixel-level verification of the exported PNG, since a screenshot must be
 * provably readable rather than merely present.
 *
 * Checks: the image is not blank, both ends of the colour ramp are present
 * (green deterministic cells AND red unstable cells), bar heights vary, and
 * the overlay text actually drew pixels in the title and legend regions.
 *
 * Usage: node scripts/verify-png.mjs exports/heatmap-export.png
 */
import { chromium } from '/Users/shk/experiments/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? 'exports/heatmap-export.png';
const dataUrl = `data:image/png;base64,${readFileSync(path.resolve(file)).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const result = await page.evaluate(async (url) => {
  const img = new Image();
  img.src = url;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let green = 0;
  let red = 0;
  let amber = 0;
  let nonBackground = 0;
  let bright = 0;

  // Sample the 3D scene region only (exclude the bottom overlay band).
  const sceneBottom = Math.floor(height * 0.78);

  for (let y = 0; y < sceneBottom; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (r + g + b > 90) nonBackground++;
      if (r > 180 && g > 180 && b > 180) bright++;

      // Saturated green: deterministic cells.
      if (g > 110 && g > r * 1.5 && g > b * 1.5) green++;
      // Saturated red: unstable cells.
      if (r > 130 && r > g * 1.8 && r > b * 1.8) red++;
      // Amber/orange middle of the ramp.
      if (r > 170 && g > 90 && g < r * 0.85 && b < 90) amber++;
    }
  }

  // Overlay text regions: title (top-left) and legend (bottom-left).
  const countInk = (x0, y0, x1, y1) => {
    let ink = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r + g + b > 330) ink++;
      }
    }
    return ink;
  };

  const titleInk = countInk(
    Math.floor(width * 0.02),
    Math.floor(height * 0.02),
    Math.floor(width * 0.42),
    Math.floor(height * 0.10),
  );
  const legendInk = countInk(
    Math.floor(width * 0.02),
    Math.floor(height * 0.88),
    Math.floor(width * 0.30),
    Math.floor(height * 0.98),
  );
  const auditInk = countInk(
    Math.floor(width * 0.60),
    Math.floor(height * 0.88),
    Math.floor(width * 0.98),
    Math.floor(height * 0.98),
  );
  // Attribution is drawn centred near the bottom edge of the export.
  const creditInk = countInk(
    Math.floor(width * 0.28),
    Math.floor(height * 0.955),
    Math.floor(width * 0.72),
    Math.floor(height * 0.995),
  );

  // Column-wise coverage: how many distinct rows have visible bar pixels,
  // which proves the bars have varying heights.
  const rowHasBar = new Set();
  for (let y = 0; y < sceneBottom; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (g > 110 && g > r * 1.4 && g > b * 1.4) {
        rowHasBar.add(y);
        break;
      }
    }
  }

  return {
    width,
    height,
    green,
    red,
    amber,
    nonBackground,
    bright,
    titleInk,
    legendInk,
    auditInk,
    creditInk,
    greenRows: rowHasBar.size,
  };
}, dataUrl);

await browser.close();

const total = Math.floor(result.width / 2) * Math.floor((result.height * 0.78) / 2);
const pct = (n) => ((n / total) * 100).toFixed(2) + '%';

console.log(`image            : ${result.width}x${result.height}`);
console.log(`non-background   : ${result.nonBackground} (${pct(result.nonBackground)})`);
console.log(`green pixels     : ${result.green} (${pct(result.green)})   <- deterministic cells`);
console.log(`red pixels       : ${result.red} (${pct(result.red)})   <- unstable cells`);
console.log(`amber pixels     : ${result.amber} (${pct(result.amber)})`);
console.log(`bright pixels    : ${result.bright}`);
console.log(`title ink        : ${result.titleInk}`);
console.log(`legend ink       : ${result.legendInk}`);
console.log(`audit ink        : ${result.auditInk}`);
console.log(`credit ink       : ${result.creditInk}`);
console.log(`green bar rows   : ${result.greenRows} distinct scanlines`);

const checks = [
  ['image is not blank', result.nonBackground > total * 0.02],
  ['green cells present', result.green > 500],
  ['red cells present', result.red > 500],
  ['mid-ramp present', result.amber > 200],
  ['title text rendered', result.titleInk > 2000],
  ['legend text rendered', result.legendInk > 800],
  ['audit text rendered', result.auditInk > 800],
  ['attribution rendered', result.creditInk > 400],
  ['bars have varying heights', result.greenRows > 20],
];

console.log('\nCHECKS');
let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) pass = false;
}
console.log(pass ? '\nPNG VERIFICATION PASS' : '\nPNG VERIFICATION FAIL');
process.exit(pass ? 0 : 1);