/**
 * Headless sweep runner for verification runs.
 *
 * Usage:
 *   pnpm -C server sweep --reps 10 --label run1
 *
 * Reads the API key from PARTICLE_AI_API_KEY (or --key), drives the same
 * SweepManager the HTTP server uses, and writes to the same JSONL. Prints a
 * per-cell table plus the nonce audit.
 */
import { readFileSync } from 'node:fs';
import { SweepManager } from './manager.js';
import { DEFAULT_PROMPTS, DEFAULT_SYSTEM_PROMPT } from './sweep.js';
import { JSONL_PATH, ensureDataDir } from './store.js';
import type { SweepView } from './types.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/** Fall back to the DSH credential store so no key is ever hardcoded here. */
function resolveKey(): string {
  if (process.env.PARTICLE_AI_API_KEY) return process.env.PARTICLE_AI_API_KEY;
  const explicit = arg('key', '');
  if (explicit) return explicit;
  try {
    const home = process.env.HOME ?? '';
    const txt = readFileSync(`${home}/.dsh/.credentials.yaml`, 'utf8');
    const m = txt.match(/PARTICLE_AI_API_KEY:\s*(\S+)/);
    if (m?.[1]) return m[1].replace(/^["']|["']$/g, '');
  } catch {
    /* fall through */
  }
  return '';
}

const reps = Number(arg('reps', '10'));
const label = arg('label', 'run');
const modelA = arg('modelA', 'deepseek-v4-flash-0731');
const modelB = arg('modelB', 'deepseek-v4.1-flash');
const temperature = Number(arg('temperature', '0'));
const maxTokens = Number(arg('maxTokens', '1600'));
const disableReasoning = process.argv.includes('--disable-reasoning');

const apiKey = resolveKey();
if (!apiKey) {
  console.error('No API key. Set PARTICLE_AI_API_KEY or pass --key.');
  process.exit(1);
}

await ensureDataDir();
const manager = new SweepManager();
await manager.recover();

const id = manager.start({
  prompts: DEFAULT_PROMPTS,
  reps,
  config: {
    baseUrl: arg('baseUrl', 'https://api.particle.ai/v1'),
    apiKey,
    modelA,
    modelB,
    temperature,
    maxTokens,
    disableReasoning,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  },
});

console.log(`[${label}] sweep ${id} — ${DEFAULT_PROMPTS.length} prompts x 2 models x ${reps} reps`);
console.log(`[${label}] JSONL: ${JSONL_PATH}\n`);

let lastCell = -1;
const done = new Promise<SweepView>((resolve) => {
  manager.subscribe(id, (event, payload) => {
    if (event === 'progress') {
      const p = payload as SweepView['progress'];
      if (p) process.stdout.write(`\r  cell ${p.cellIndex + 1}/${p.totalCells} · rep ${p.rep}/${p.totalReps}   `);
    } else if (event === 'cell') {
      const c = payload as SweepView['cells'][number];
      // Only report a cell once all of its reps have landed. Reporting after
      // rep 1 would always read det=1.00 (one sample is trivially identical
      // to itself) and misrepresent the result while the sweep runs.
      if (c && c.okCount + c.errorCount >= reps && c.cellIndex !== lastCell) {
        lastCell = c.cellIndex;
        process.stdout.write(
          `\r  ${c.promptLabel.padEnd(24)} ${c.modelSlot}  det=${c.determinismScore.toFixed(2)}  distinct=${c.distinctOutputs}/${c.okCount}  reasoning=${c.meanReasoningTokens}\n`,
        );
      }
    } else if (event === 'done') {
      resolve(payload as SweepView);
    }
  });
});

const view = await done;

console.log('\n' + '='.repeat(92));
console.log(`RESULTS — ${label} (${id})`);
console.log('='.repeat(92));
console.log(
  'prompt'.padEnd(24) +
    'model'.padEnd(8) +
    'det'.padEnd(7) +
    'distinct'.padEnd(10) +
    'latency'.padEnd(10) +
    'reason.tok',
);
console.log('-'.repeat(92));
for (const c of view.cells) {
  console.log(
    c.promptLabel.padEnd(24) +
      c.modelSlot.padEnd(8) +
      c.determinismScore.toFixed(2).padEnd(7) +
      `${c.distinctOutputs}/${c.okCount}`.padEnd(10) +
      `${(c.meanLatencyMs / 1000).toFixed(2)}s`.padEnd(10) +
      String(c.meanReasoningTokens),
  );
}

console.log('\nNONCE AUDIT');
console.log(`  calls issued : ${view.nonceAudit.issued}`);
console.log(`  unique nonces: ${view.nonceAudit.unique}`);
console.log(`  duplicates   : ${view.nonceAudit.duplicates.length}`);
console.log(`  verdict      : ${view.nonceAudit.ok ? 'PASS — no nonce reused' : 'FAIL — determinism invalid'}`);

const errors = view.cells.reduce((a, c) => a + c.errorCount, 0);
console.log(`  call errors  : ${errors}`);
console.log(`  status       : ${view.status}`);

if (!view.nonceAudit.ok) {
  console.error('\nFATAL: duplicate nonces detected — results must be discarded.');
  process.exit(2);
}
process.exit(0);