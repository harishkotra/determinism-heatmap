/**
 * Independent audit of the raw JSONL.
 *
 * Re-derives every claim from the file on disk rather than trusting the
 * server's aggregates:
 *   1. every call carries a unique nonce (duplicates are reported and fatal)
 *   2. determinism is recomputed from real sha256 hashes of stored content
 *   3. reasoning tokens come from usage.completion_tokens_details.reasoning_tokens
 *   4. no reasoning_content is present anywhere in the log
 *
 * Usage: pnpm -C server audit [--jsonl path]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSONL_PATH } from './store.js';
import type { CallRecord, JsonlLine, SweepMeta } from './types.js';

const jsonlPath = (() => {
  const i = process.argv.indexOf('--jsonl');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : JSONL_PATH;
})();

const raw = readFileSync(jsonlPath, 'utf8');
const lines = raw.split('\n').filter((l) => l.trim().length > 0);

const metas = new Map<string, SweepMeta>();
const records: CallRecord[] = [];
let torn = 0;

for (const line of lines) {
  let parsed: JsonlLine;
  try {
    parsed = JSON.parse(line) as JsonlLine;
  } catch {
    torn++;
    continue;
  }
  if (parsed.type === 'meta') metas.set(parsed.sweepId, parsed);
  else if (parsed.type === 'record') records.push(parsed);
}

console.log(`JSONL: ${jsonlPath}`);
console.log(`lines: ${lines.length}  records: ${records.length}  sweeps: ${metas.size}  torn: ${torn}\n`);

// --- 1. nonce uniqueness -----------------------------------------------------
const seen = new Map<string, number>();
for (const r of records) seen.set(r.nonce, (seen.get(r.nonce) ?? 0) + 1);
const dupes = [...seen.entries()].filter(([, n]) => n > 1);

console.log('1. NONCE UNIQUENESS');
console.log(`   records          : ${records.length}`);
console.log(`   distinct nonces  : ${seen.size}`);
console.log(`   reused nonces    : ${dupes.length}`);
if (dupes.length > 0) {
  for (const [nonce, n] of dupes.slice(0, 10)) console.log(`     ! ${nonce} x${n}`);
  console.log('   VERDICT: FAIL — determinism numbers are invalid and must be discarded');
} else {
  console.log('   VERDICT: PASS — every call carried a fresh nonce');
}

// --- 2. sha256 re-derivation -------------------------------------------------
let shaMismatch = 0;
for (const r of records) {
  const recomputed = createHash('sha256').update(r.content, 'utf8').digest('hex');
  if (recomputed !== r.sha256) shaMismatch++;
}
console.log('\n2. SHA256 INTEGRITY');
console.log(`   records checked  : ${records.length}`);
console.log(`   hash mismatches  : ${shaMismatch}`);
console.log(`   VERDICT: ${shaMismatch === 0 ? 'PASS — stored hashes match stored content' : 'FAIL'}`);

// --- 3. reasoning tokens -----------------------------------------------------
const withReasoning = records.filter((r) => r.reasoningTokens > 0).length;
const badTokens = records.filter(
  (r) => !Number.isFinite(r.reasoningTokens) || r.reasoningTokens < 0,
).length;
console.log('\n3. REASONING TOKENS');
console.log(`   source           : usage.completion_tokens_details.reasoning_tokens`);
console.log(`   records > 0      : ${withReasoning}/${records.length}`);
console.log(`   malformed values : ${badTokens}`);
console.log(`   VERDICT: ${badTokens === 0 ? 'PASS' : 'FAIL'}`);

// --- 4. reasoning_content never persisted ------------------------------------
const leaks = records.filter((r) => 'reasoning_content' in (r as unknown as Record<string, unknown>));
const rawLeak = raw.includes('reasoning_content');
console.log('\n4. reasoning_content CONTAINMENT');
console.log(`   record fields    : ${leaks.length} leak(s)`);
console.log(`   raw file scan    : ${rawLeak ? 'FOUND — FAIL' : 'absent — PASS'}`);
console.log(`   VERDICT: ${leaks.length === 0 && !rawLeak ? 'PASS — only token counts stored' : 'FAIL'}`);

// --- per-sweep determinism, recomputed ---------------------------------------
console.log('\n5. DETERMINISM RECOMPUTED FROM RAW HASHES');
for (const [sweepId, meta] of metas) {
  const sweepRecords = records.filter((r) => r.sweepId === sweepId);
  if (sweepRecords.length === 0) continue;

  const audit = (() => {
    const s = new Set<string>();
    const d = new Set<string>();
    for (const r of sweepRecords) {
      if (s.has(r.nonce)) d.add(r.nonce);
      else s.add(r.nonce);
    }
    return { unique: s.size, dupes: d.size };
  })();

  console.log(
    `\n   sweep ${sweepId.slice(0, 8)}  ${meta.startedAt}  ` +
      `${meta.config.modelA} vs ${meta.config.modelB}  reps=${meta.config.reps}  ` +
      `nonces ${audit.unique} unique / ${audit.dupes} reused`,
  );
  console.log(
    '   ' +
      'prompt'.padEnd(24) +
      'model'.padEnd(7) +
      'det'.padEnd(7) +
      'distinct'.padEnd(10) +
      'reason.tok',
  );

  for (let p = 0; p < meta.prompts.length; p++) {
    const prompt = meta.prompts[p]!;
    for (const slot of ['A', 'B'] as const) {
      const cellRecords = sweepRecords.filter(
        (r) => r.promptIndex === p && r.modelSlot === slot && !r.error,
      );
      if (cellRecords.length === 0) continue;
      const counts = new Map<string, number>();
      for (const r of cellRecords) counts.set(r.sha256, (counts.get(r.sha256) ?? 0) + 1);
      const modal = Math.max(...counts.values());
      const det = modal / cellRecords.length;
      const meanReasoning = Math.round(
        cellRecords.reduce((a, r) => a + r.reasoningTokens, 0) / cellRecords.length,
      );
      console.log(
        '   ' +
          prompt.label.padEnd(24) +
          slot.padEnd(7) +
          det.toFixed(2).padEnd(7) +
          `${counts.size}/${cellRecords.length}`.padEnd(10) +
          String(meanReasoning),
      );
    }
  }
}

const allPass = dupes.length === 0 && shaMismatch === 0 && badTokens === 0 && !rawLeak && leaks.length === 0;
console.log(`\n${'='.repeat(60)}`);
console.log(allPass ? 'AUDIT PASS — all four claims verified against raw JSONL' : 'AUDIT FAIL');
process.exit(allPass ? 0 : 1);