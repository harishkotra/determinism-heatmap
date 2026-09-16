import type { CallRecord, CellAggregate, NonceAudit, PromptDef, SweepConfig } from './types.js';

export const DEFAULT_SYSTEM_PROMPT =
  "You are a precise assistant. Answer the user's request directly.";

/**
 * The default 8-prompt spectrum, ordered from closed-form (expected green and
 * short) to open creative (expected red and tall).
 */
export const DEFAULT_PROMPTS: PromptDef[] = [
  {
    id: 'recall',
    label: 'Exact recall',
    text: 'List the first 12 prime numbers, separated by commas, and nothing else.',
  },
  {
    id: 'maths',
    label: 'Maths',
    text: 'What is 847 * 293? Show the multiplication steps, then give the final number on its own line.',
  },
  {
    id: 'spatial',
    label: 'Spatial / formatting',
    text: 'Output a 5x5 multiplication table for the numbers 1 through 5 as a Markdown table. No other text.',
  },
  {
    id: 'explain',
    label: 'One-sentence explanation',
    text: 'Explain what a hash function is in exactly one sentence.',
  },
  {
    id: 'ascii',
    label: 'ASCII drawing',
    text: 'Draw a simple ASCII art cat, 5 lines tall. Output only the drawing.',
  },
  {
    id: 'haiku',
    label: 'Haiku',
    text: 'Write a haiku about the ocean at dawn.',
  },
  {
    id: 'joke',
    label: 'Joke',
    text: 'Tell me a short joke about programmers.',
  },
  {
    id: 'creative',
    label: 'Open creative',
    text: 'Describe a city that exists only at the moment between sleeping and waking. Be vivid and specific.',
  },
];

/** Build the exact string sent to the model: base prompt + fresh nonce. */
export function withNonce(base: string, nonce: string): string {
  return `${base}\n\n<!--nonce:${nonce}-->`;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate one (prompt, model) cell from its raw records.
 *
 * determinismScore = count(modal sha256) / reps, computed over successful
 * calls. Errors are excluded from the ratio and reported separately, so a
 * provider outage can never masquerade as determinism.
 */
export function aggregateCell(
  prompt: PromptDef,
  promptIndex: number,
  model: string,
  modelSlot: 'A' | 'B',
  cellIndex: number,
  reps: number,
  records: CallRecord[],
): CellAggregate {
  const ok = records.filter((r) => !r.error);
  const counts = new Map<string, number>();
  for (const r of ok) counts.set(r.sha256, (counts.get(r.sha256) ?? 0) + 1);

  let modalSha: string | null = null;
  let modalCount = 0;
  for (const [sha, count] of counts) {
    if (count > modalCount) {
      modalCount = count;
      modalSha = sha;
    }
  }

  const denominator = ok.length || reps;

  return {
    cellIndex,
    promptIndex,
    promptId: prompt.id,
    promptLabel: prompt.label,
    promptText: prompt.text,
    model,
    modelSlot,
    reps,
    okCount: ok.length,
    errorCount: records.length - ok.length,
    determinismScore: denominator === 0 ? 0 : modalCount / denominator,
    modalSha,
    distinctOutputs: counts.size,
    meanLatencyMs: Math.round(mean(ok.map((r) => r.latencyMs))),
    meanReasoningTokens: Math.round(mean(ok.map((r) => r.reasoningTokens))),
    meanCompletionTokens: Math.round(mean(ok.map((r) => r.completionTokens))),
    totalReasoningTokens: ok.reduce((a, r) => a + r.reasoningTokens, 0),
  };
}

/** Count duplicate nonces across all persisted records for one sweep. */
export function auditNonces(records: CallRecord[]): NonceAudit {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const r of records) {
    if (seen.has(r.nonce)) duplicates.add(r.nonce);
    else seen.add(r.nonce);
  }
  const dupes = [...duplicates].sort();
  return { issued: records.length, unique: seen.size, duplicates: dupes, ok: dupes.length === 0 };
}

export function redactConfig(cfg: SweepConfig): Omit<SweepConfig, 'apiKey'> {
  const { apiKey: _apiKey, ...rest } = cfg;
  return rest;
}