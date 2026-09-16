/**
 * End-to-end smoke test through the real UI on the canonical ports:
 * load the page, click "Run sweep", watch it stream, then cancel.
 *
 * Usage: node scripts/smoke-ui.mjs [url]
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
await page.waitForSelector('h1', { timeout: 20000 });
await page.waitForTimeout(1500);

console.log('loaded:', await page.textContent('h1'));
console.log('start bar:', (await page.textContent('.startbar-meta')).replace(/\s+/g, ' ').trim());

// Reduce the workload so the smoke test is quick: 2 prompts x 2 models x 2 reps.
await page.click('text=✎ Prompts');
await page.waitForTimeout(400);
const rows = page.locator('.prompt-row');
const n = await rows.count();
for (let i = n - 1; i >= 2; i--) {
  await rows.nth(i).locator('button.icon.danger').click();
  await page.waitForTimeout(80);
}
console.log('prompts reduced to:', await rows.count());
await page.click('.modal-head button.icon');
await page.waitForTimeout(300);

await page.click('text=⚙ Settings');
await page.waitForTimeout(400);
const reps = page.locator('input[type=number]').nth(2);
await reps.fill('2');
await page.waitForTimeout(200);
await page.click('.modal-head button.icon');
await page.waitForTimeout(300);

console.log('start bar now:', (await page.textContent('.startbar-meta')).replace(/\s+/g, ' ').trim());

// Start the sweep.
await page.click('button.primary');
console.log('clicked Run sweep');

// Watch the progress panel appear and advance — proves the stream is live.
let sawProgress = false;
let firstText = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const status = (await page.textContent('.status').catch(() => '')) ?? '';
  const prog = await page.locator('.progress-text').first().textContent().catch(() => null);
  if (prog) {
    sawProgress = true;
    if (!firstText) firstText = prog;
    if (i % 5 === 0) console.log(`  [${status}] ${prog}`);
  }
  if (status === 'complete' || status === 'cancelled' || status === 'error') {
    console.log(`  final status: ${status}`);
    break;
  }
}

console.log('progress panel seen:', sawProgress, '| first:', firstText);

const finalStatus = await page.textContent('.status');
const rowsNow = await page.locator('.results tbody tr').count();
console.log('final status:', finalStatus, '| measured cells:', rowsNow);

const audit = await page.locator('.legend-ok, .legend-bad').first().textContent().catch(() => null);
console.log('nonce audit:', audit);

await page.screenshot({ path: 'exports/smoke-ui.png' });
console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none');

await browser.close();