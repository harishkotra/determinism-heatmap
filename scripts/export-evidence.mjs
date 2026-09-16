/**
 * Copy the raw JSONL and the exported PNG into exports/ so the claim ships
 * with its evidence.
 *
 * Usage: node scripts/export-evidence.mjs
 */
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const exportsDir = path.join(root, 'exports');
mkdirSync(exportsDir, { recursive: true });

const jsonlSrc = path.join(root, 'server/data/sweeps.jsonl');
if (!existsSync(jsonlSrc)) {
  console.error('no JSONL yet — run a sweep first');
  process.exit(1);
}

const jsonlDst = path.join(exportsDir, 'determinism-sweeps.jsonl');
copyFileSync(jsonlSrc, jsonlDst);

const lines = readFileSync(jsonlDst, 'utf8').split('\n').filter((l) => l.trim());
const records = lines
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((x) => x && x.type === 'record');

console.log(`JSONL  -> ${jsonlDst}`);
console.log(`  ${lines.length} lines, ${records.length} call records`);

const png = path.join(exportsDir, 'heatmap-export.png');
if (existsSync(png)) console.log(`PNG    -> ${png}`);
else console.log('PNG    -> not yet exported (use the Export PNG button)');

// A compact manifest so the two artifacts are provably a matched pair.
const sweeps = [...new Set(records.map((r) => r.sweepId))];
writeFileSync(
  path.join(exportsDir, 'manifest.json'),
  JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      jsonl: path.basename(jsonlDst),
      png: existsSync(png) ? path.basename(png) : null,
      sweeps: sweeps.map((id) => ({
        id,
        records: records.filter((r) => r.sweepId === id).length,
      })),
      totalRecords: records.length,
    },
    null,
    2,
  ),
);
console.log(`manifest -> ${path.join(exportsDir, 'manifest.json')}`);