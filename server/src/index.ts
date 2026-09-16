import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { SweepManager } from './manager.js';
import { DEFAULT_PROMPTS, DEFAULT_SYSTEM_PROMPT } from './sweep.js';
import { DATA_DIR, JSONL_PATH, ensureDataDir } from './store.js';
import type { PromptDef, SweepConfig } from './types.js';

const PORT = Number(process.env.PORT ?? 3001);

const manager = new SweepManager();
await ensureDataDir();
await manager.recover();

const app = new Hono();
app.use('*', cors());

/**
 * The API key may arrive from the browser (settings panel, persisted to
 * localStorage) or from the server environment. The env var is a convenience
 * for local runs so a key never has to be typed in or committed to the repo —
 * it is NOT a hardcoded key, and the UI value always wins when present.
 */
const SERVER_KEY = process.env.PARTICLE_AI_API_KEY ?? '';
const hasServerKey = SERVER_KEY.trim().length > 0;

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    jsonlPath: JSONL_PATH,
    dataDir: DATA_DIR,
    sweeps: manager.list().length,
    hasServerKey,
  }),
);

app.get('/api/defaults', (c) =>
  c.json({
    baseUrl: 'https://api.particle.ai/v1',
    modelA: 'deepseek-v4-flash-0731',
    modelB: 'deepseek-v4.1-flash',
    temperature: 0,
    maxTokens: 1600,
    reps: 10,
    disableReasoning: false,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    prompts: DEFAULT_PROMPTS,
    jsonlPath: JSONL_PATH,
    hasServerKey,
  }),
);

app.get('/api/sweeps', async (c) => {
  await manager.refreshIfEmpty();
  return c.json({ sweeps: manager.list(), latest: manager.latestId() });
});

/**
 * Re-attach after a page reload: latest sweep id, if any.
 *
 * NOTE: this must be registered BEFORE `/api/sweep/:id`, otherwise the
 * parameterised route swallows it and treats "latest" as a sweep id.
 */
app.get('/api/sweep/latest', async (c) => {
  await manager.refreshIfEmpty();
  const id = manager.latestId();
  if (!id) return c.json({ error: 'no sweeps yet' }, 404);
  const view = manager.view(id);
  if (!view) return c.json({ error: 'sweep not found' }, 404);
  return c.json(view);
});

app.get('/api/sweep/:id', async (c) => {
  await manager.refreshIfEmpty();
  const view = manager.view(c.req.param('id'));
  if (!view) return c.json({ error: 'sweep not found' }, 404);
  return c.json(view);
});

app.post('/api/sweep', async (c) => {
  let body: {
    prompts?: Array<string | PromptDef>;
    reps?: number;
    config?: Partial<SweepConfig>;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const rawPrompts = body.prompts ?? DEFAULT_PROMPTS.map((p) => p.text);
  const prompts: PromptDef[] = rawPrompts.map((p, i) =>
    typeof p === 'string'
      ? { id: `p${i}`, label: `Prompt ${i + 1}`, text: p }
      : { id: p.id || `p${i}`, label: p.label || `Prompt ${i + 1}`, text: p.text },
  );

  const reps = Math.max(1, Math.min(50, Number(body.reps ?? 10)));
  const config = body.config ?? {};

  // Fall back to the server environment key when the browser sends none.
  const apiKey = (config.apiKey ?? '').trim() || SERVER_KEY;
  if (!apiKey) {
    return c.json(
      { error: 'API key is required. Paste one in Settings, or start the server with PARTICLE_AI_API_KEY.' },
      400,
    );
  }
  if (!config.baseUrl) return c.json({ error: 'Base URL is required.' }, 400);
  if (!config.modelA || !config.modelB) {
    return c.json({ error: 'Both Model A and Model B are required.' }, 400);
  }

  const id = manager.start({ prompts, reps, config: { ...config, apiKey } });
  return c.json({ id, totalCells: prompts.length * 2, totalCalls: prompts.length * 2 * reps });
});

/** SSE progress: the UI fills cell by cell instead of looking frozen. */
app.get('/api/sweep/:id/stream', (c) => {
  const id = c.req.param('id');
  const view = manager.view(id);
  if (!view) return c.json({ error: 'sweep not found' }, 404);

  return streamSSE(c, async (stream) => {
    // Snapshot first so a late subscriber is never behind.
    await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(view) });

    if (view.status !== 'sweeping') {
      await stream.writeSSE({ event: 'done', data: JSON.stringify(view) });
      return;
    }

    await new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe(id, (event, payload) => {
        // The terminal `done` write MUST be awaited before resolving: the
        // stream closes as soon as this callback returns, and a dropped `done`
        // makes EventSource auto-reconnect — restarting the whole stream.
        void (async () => {
          try {
            await stream.writeSSE({ event, data: JSON.stringify(payload) });
          } catch {
            /* client already gone */
          }
          if (event === 'done') {
            clearInterval(heartbeat);
            unsubscribe();
            resolve();
          }
        })();
      });

      // Heartbeat keeps proxies and browsers from idling the connection out.
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      }, 5000);

      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
        resolve();
      });
    });
  });
});

app.post('/api/sweep/:id/cancel', (c) => {
  const id = c.req.param('id');
  const ok = manager.cancel(id);
  if (!ok) return c.json({ error: 'sweep not running' }, 409);
  return c.json({ ok: true, id });
});

/**
 * Replay a finished sweep's recorded calls so the run can be shown filling in
 * without re-measuring anything. Streams the same events a live sweep emits.
 */
app.get('/api/sweep/:id/replay', (c) => {
  const id = c.req.param('id');
  const view = manager.view(id);
  if (!view) return c.json({ error: 'sweep not found' }, 404);
  if (view.status === 'sweeping') {
    return c.json({ error: 'sweep is still running — watch it live instead' }, 409);
  }
  if (view.records.length === 0) {
    return c.json({ error: 'this sweep has no records to replay' }, 409);
  }

  const delay = Math.max(0, Math.min(2000, Number(c.req.query('delay') ?? 55)));

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(view) });

    await new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe(id, (event, payload) => {
        // Await the write before resolving — see the note on /stream. If `done`
        // is dropped, EventSource reconnects and the replay restarts forever.
        void (async () => {
          try {
            await stream.writeSSE({ event, data: JSON.stringify(payload) });
          } catch {
            /* client already gone */
          }
          if (event === 'done') {
            unsubscribe();
            resolve();
          }
        })();
      });

      stream.onAbort(() => {
        unsubscribe();
        resolve();
      });

      void manager.replay(id, delay).then((started) => {
        if (!started) {
          unsubscribe();
          resolve();
        }
      });
    });
  });
});

/** Raw JSONL export so the claim stays auditable. */
app.get('/api/export/jsonl', async (c) => {
  const { readFile } = await import('node:fs/promises');
  try {
    const text = await readFile(JSONL_PATH, 'utf8');
    return c.body(text, 200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': 'attachment; filename="determinism-sweeps.jsonl"',
    });
  } catch {
    return c.json({ error: 'no records yet' }, 404);
  }
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[determinism-heatmap] server on http://127.0.0.1:${info.port}`);
  console.log(`[determinism-heatmap] JSONL log: ${JSONL_PATH}`);
});