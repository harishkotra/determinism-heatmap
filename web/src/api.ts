import type { PromptDef, Settings, SweepView } from './types';

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.ok) {
    const msg = (parsed as { error?: string }).error ?? text.slice(0, 400);
    throw new Error(msg);
  }
  return parsed as T;
}

export async function fetchLatestSweep(): Promise<SweepView | null> {
  const res = await fetch('/api/sweep/latest');
  if (res.status === 404) return null;
  return jsonOrThrow<SweepView>(res);
}

export async function fetchSweep(id: string): Promise<SweepView> {
  return jsonOrThrow<SweepView>(await fetch(`/api/sweep/${id}`));
}

/** Whether the server was started with a key in its environment. */
export async function fetchServerKeyStatus(): Promise<boolean> {
  try {
    const res = await fetch('/api/defaults');
    if (!res.ok) return false;
    const body = (await res.json()) as { hasServerKey?: boolean };
    return body.hasServerKey === true;
  } catch {
    return false;
  }
}

export interface SweepSummary {
  id: string;
  status: SweepView['status'];
  startedAt: string;
  cells: number;
}

export async function fetchSweeps(): Promise<SweepSummary[]> {
  try {
    const res = await fetch('/api/sweeps');
    if (!res.ok) return [];
    const body = (await res.json()) as { sweeps?: SweepSummary[] };
    return body.sweeps ?? [];
  } catch {
    return [];
  }
}

export async function startSweep(
  prompts: PromptDef[],
  settings: Settings,
): Promise<{ id: string; totalCells: number; totalCalls: number }> {
  const res = await fetch('/api/sweep', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompts,
      reps: settings.reps,
      config: {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        modelA: settings.modelA,
        modelB: settings.modelB,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        disableReasoning: settings.disableReasoning,
      },
    }),
  });
  return jsonOrThrow(res);
}

export async function cancelSweep(id: string): Promise<void> {
  await fetch(`/api/sweep/${id}/cancel`, { method: 'POST' });
}

export interface StreamHandlers {
  onSnapshot: (view: SweepView) => void;
  onProgress: (p: SweepView['progress']) => void;
  onCell: (cell: SweepView['cells'][number]) => void;
  onReset?: (cells: SweepView['cells']) => void;
  onStatus: (status: SweepView['status']) => void;
  onDone: (view: SweepView) => void;
  onError: (message: string) => void;
}

/**
 * Subscribe to a sweep's SSE stream. Returns a disposer.
 * The browser's EventSource reconnects on its own; we just wire the events.
 *
 * `path` lets the same wiring drive both a live sweep and a replay.
 */
export function streamSweep(
  id: string,
  handlers: StreamHandlers,
  path: 'stream' | 'replay' = 'stream',
): () => void {
  const es = new EventSource(`/api/sweep/${id}/${path}`);

  const parse = <T,>(e: MessageEvent): T | null => {
    try {
      return JSON.parse(e.data) as T;
    } catch {
      return null;
    }
  };

  es.addEventListener('snapshot', (e) => {
    const v = parse<SweepView>(e as MessageEvent);
    if (v) handlers.onSnapshot(v);
  });
  es.addEventListener('reset', (e) => {
    const cells = parse<SweepView['cells']>(e as MessageEvent);
    if (cells && handlers.onReset) handlers.onReset(cells);
  });
  es.addEventListener('progress', (e) => {
    const p = parse<SweepView['progress']>(e as MessageEvent);
    if (p) handlers.onProgress(p);
  });
  es.addEventListener('cell', (e) => {
    const c = parse<SweepView['cells'][number]>(e as MessageEvent);
    if (c) handlers.onCell(c);
  });
  es.addEventListener('status', (e) => {
    const s = parse<SweepView['status']>(e as MessageEvent);
    if (s) handlers.onStatus(s);
  });
  es.addEventListener('done', (e) => {
    const v = parse<SweepView>(e as MessageEvent);
    if (v) handlers.onDone(v);
    es.close();
  });
  es.addEventListener('error', () => {
    // EventSource fires this on stream close too; only surface a real failure
    // once the connection is fully closed.
    if (es.readyState === EventSource.CLOSED) {
      handlers.onError('progress stream closed unexpectedly');
    }
  });

  return () => es.close();
}