import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallRecord, JsonlLine, SweepEnd, SweepMeta } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.HEATMAP_DATA_DIR ?? path.resolve(here, '../data');

/** Every sweep appends to one append-only log; nothing is ever rewritten. */
export const JSONL_PATH = path.join(DATA_DIR, 'sweeps.jsonl');

export async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

/**
 * Append lines durably. Each line is one JSON object; a torn final line from a
 * crash is tolerated by the reader rather than corrupting the whole file.
 */
export async function appendLines(lines: JsonlLine[]): Promise<void> {
  if (lines.length === 0) return;
  await ensureDataDir();
  const payload = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await appendFile(JSONL_PATH, payload, 'utf8');
}

export interface RecoveredSweep {
  meta: SweepMeta;
  records: CallRecord[];
  end: SweepEnd | null;
}

/**
 * Read the whole log and rebuild sweep state. This is what lets a sweep
 * survive a page reload or a server restart: the JSONL is the source of truth.
 */
export async function readAllSweeps(): Promise<Map<string, RecoveredSweep>> {
  const sweeps = new Map<string, RecoveredSweep>();
  let text: string;
  try {
    text = await readFile(JSONL_PATH, 'utf8');
  } catch {
    return sweeps;
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(trimmed) as JsonlLine;
    } catch {
      continue; // torn/partial line from an interrupted write
    }
    if (parsed.type === 'meta') {
      sweeps.set(parsed.sweepId, { meta: parsed, records: [], end: null });
    } else if (parsed.type === 'record') {
      const entry = sweeps.get(parsed.sweepId);
      if (entry) entry.records.push(parsed);
    } else if (parsed.type === 'end') {
      const entry = sweeps.get(parsed.sweepId);
      if (entry) entry.end = parsed;
    }
  }
  return sweeps;
}

export async function listJsonlFiles(): Promise<string[]> {
  try {
    return (await readdir(DATA_DIR)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
}