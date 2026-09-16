/**
 * Verifies the Run and Replay buttons in the real UI.
 *
 * Replay is the important one: it must clear the grid first, then fill it in
 * cell by cell, and must never claim to be measuring anything new.
 *
 * Usage: node scripts/verify-replay.mjs [url]
 */
import { chromium } from '/Users/shk/experiments/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

const url = process.argv[2] ?? 'http://localhost:5173/';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1');
await page.waitForTimeout(3000);

// The run button must be visible without scrolling.
const runBtn = page.locator('.overlay-controls button.primary-inline');
console.log('Run button visible in overlay:', await runBtn.isVisible());
const box = await runBtn.boundingBox();
const vh = page.viewportSize().height;
console.log(`  at y=${Math.round(box.y)} (viewport height ${vh}) — above the fold:`, box.y < vh);

console.log('replay button count:', await page.locator('button:has-text("↻ Replay")').count());
console.log('cells before replay:', await page.locator('.results tbody tr').count());

// --- replay -----------------------------------------------------------------
await page.click('.overlay-controls button:has-text("↻ Replay")');
console.log('clicked Replay');

// Sample the measured-cell count over time; it should climb from ~0.
const samples = [];
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(500);
  const status = (await page.textContent('.status').catch(() => '')) ?? '';
  const prog = await page.locator('.progress-text').first().textContent().catch(() => null);
  const banner = await page.locator('.replay-banner').count();
  const measured = await page.locator('.results tbody tr').count();
  samples.push({ t: (i + 1) * 0.5, status, prog, banner, measured });
  if (i === 1 || i === 4 || i === 9 || i === 19) {
    console.log(
      `  t=${samples[i].t}s status=${status} banner=${banner} measured=${measured} ${prog ?? ''}`,
    );
  }
  if (status === 'complete' || status === 'cancelled' || status === 'error') break;
}

const climbing = samples.some((s) => s.measured > 0 && s.measured < 16);
const bannerSeen = samples.some((s) => s.banner > 0);
console.log('\nprogress climbed through partial states:', climbing);
console.log('replay banner shown (honest labelling):', bannerSeen);
console.log('final status:', await page.textContent('.status'));
console.log('final measured cells:', await page.locator('.results tbody tr').count());
console.log('nonce audit:', await page.locator('.legend-ok, .legend-bad').first().textContent());

await page.screenshot({ path: 'exports/replay-check.png' });
console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none');

await browser.close();