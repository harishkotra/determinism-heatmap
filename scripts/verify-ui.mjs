/**
 * Drives the real UI in a browser: loads the page, waits for the sweep to
 * stream in, hovers a cell, and exports the PNG.
 *
 * Usage: node scripts/verify-ui.mjs <webUrl>
 */
import { chromium } from '/Users/shk/experiments/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5183/';
const outDir = path.resolve('exports');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

// `networkidle` never settles against the Vite dev server because its HMR
// websocket stays open, so wait for the DOM and then for real content.
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1', { timeout: 20000 });
await page.waitForTimeout(2500);

// --- assertions --------------------------------------------------------------
const title = await page.textContent('h1');
console.log('title:', title);

const canvasBox = await page.locator('canvas').boundingBox();
console.log('canvas:', canvasBox ? `${Math.round(canvasBox.width)}x${Math.round(canvasBox.height)}` : 'MISSING');

const legend = await page.locator('.legend-bar').count();
const status = await page.textContent('.status');
console.log('legend blocks:', legend, '| status:', status);

const nonceAudit = await page.locator('.legend-ok, .legend-bad').first().textContent().catch(() => null);
console.log('nonce audit:', nonceAudit);

const rows = await page.locator('.results tbody tr').count();
console.log('result rows:', rows);

// --- hover a tall creative cell ---------------------------------------------
const cells = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.results tbody tr')];
  return rows.map((r) => r.textContent);
});
console.log('measured cells:', cells.length);

// Hover the centre-right of the canvas where group B sits.
await page.mouse.move(canvasBox.x + canvasBox.width * 0.62, canvasBox.y + canvasBox.height * 0.5);
await page.waitForTimeout(700);
const tooltipVisible = await page.locator('.tooltip').count();
if (tooltipVisible) {
  console.log('tooltip:', (await page.textContent('.tooltip')).replace(/\s+/g, ' ').slice(0, 200));
} else {
  console.log('tooltip: none at that point');
}

await page.screenshot({ path: path.join(outDir, 'ui-screenshot.png') });

// --- PNG export --------------------------------------------------------------
const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
await page.click('text=Export PNG');
const download = await downloadPromise;
if (download) {
  const target = path.join(outDir, 'heatmap-export.png');
  await download.saveAs(target);
  console.log('exported PNG:', target);
} else {
  console.log('exported PNG: download event not captured');
}

console.log('console errors:', consoleErrors.length ? consoleErrors.slice(0, 8) : 'none');

await browser.close();
writeFileSync(path.join(outDir, 'console-errors.json'), JSON.stringify(consoleErrors, null, 2));