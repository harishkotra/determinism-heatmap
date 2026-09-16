# The Determinism Heatmap

**How deterministic is a language model, really?** Run the same prompt ten times and count how
often you get byte-identical output. Do that for eight prompts across two models and render
the result as a single 3D landscape you can read at a glance.

- **Colour** = determinism score (green = every repetition byte-identical, red = the model wanders)
- **Height** = mean reasoning tokens burned
- **The punchline** = the tall red corner: prompts that are *expensive and unstable*

---

## Table of contents

- [What this measures](#what-this-measures)
- [Quick start](#quick-start)
- [What the data actually showed](#what-the-data-actually-showed)
- [Architecture](#architecture)
- [How it works, with code](#how-it-works-with-code)
  - [1. Nonces: the whole experiment hinges on this](#1-nonces-the-whole-experiment-hinges-on-this)
  - [2. Sequential calls and token accounting](#2-sequential-calls-and-token-accounting)
  - [3. Aggregation: determinism from sha256](#3-aggregation-determinism-from-sha256)
  - [4. Crash-safe JSONL storage](#4-crash-safe-jsonl-storage)
  - [5. Live progress over SSE](#5-live-progress-over-sse)
  - [6. The perceptual colour ramp](#6-the-perceptual-colour-ramp)
  - [7. The 3D grid](#7-the-3d-grid)
  - [8. The 2x PNG export](#8-the-2x-png-export)
- [API reference](#api-reference)
- [Verification](#verification)
- [Bugs this project found in itself](#bugs-this-project-found-in-itself)
- [Forking and contributing](#forking-and-contributing)
- [Feature ideas](#feature-ideas)
- [Caveats](#caveats)
- [Tech stack](#tech-stack)
- [Non-goals](#non-goals)
- [Writing about this project](#writing-about-this-project)

---

## What this measures

A language model at `temperature: 0` is *supposed* to be deterministic. In practice it often
isn't, and the interesting question is **which prompts** break that promise.

For each `(prompt, model)` pair we run `reps` sequential calls and compute:

```
determinismScore = count(most common sha256) / reps
```

That is a deliberately strict bar. Two responses differing only in a trailing space count as
different. This is why "list the first 12 primes" scores 0.60 rather than 1.00 — the model
alternates between `2,3,5,...` and `2, 3, 5, ...`.

---

## Quick start

```bash
pnpm install
pnpm start          # or ./scripts/dev.sh
```

Then open **<http://localhost:5173>**.

`pnpm start` runs the backend on `:3001` and the frontend on `:5173` together. It resolves an
API key automatically, in this order, and never writes it to the repo:

1. `PARTICLE_AI_API_KEY` already in your environment
2. a `.env` file in the project root (gitignored)
3. the DSH credential store at `~/.dsh/.credentials.yaml`

If none is found the app still runs — paste a key into **⚙ Settings** and it is kept in
`localStorage`.

> **Ports.** If `3001` or `5173` is already taken by another project, override both:
> `API_PORT=3011 WEB_PORT=5183 pnpm dev`

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm start` | Backend + frontend together, key auto-resolved |
| `pnpm dev` | Same, but without key resolution |
| `pnpm build` | Production build of the frontend |
| `pnpm sweep --reps 10 --label run1` | Headless sweep, writes to `server/data/sweeps.jsonl` |
| `pnpm audit` | Re-derives every claim from the raw JSONL |
| `pnpm verify:ui` | Drives the real UI in a browser |
| `pnpm verify:png` | Reads the exported PNG back and checks it is readable |
| `pnpm export:evidence` | Bundles PNG + JSONL + manifest into `exports/` |

### Does it auto-run?

No. Nothing starts on its own — `pnpm start` is the only thing that launches the servers, and
it does not run a sweep for you. The heatmap you see on load is replayed from
`server/data/sweeps.jsonl`, so it renders instantly without spending any tokens.

### Run vs Replay

Both buttons live in the **top-right overlay**, visible without scrolling.

| Button | What it does | Cost |
| --- | --- | --- |
| **▶ Run sweep** | Real measurement: `prompts × 2 models × reps` sequential calls, streamed live | Tokens + ~6–10 min for the default 160 calls |
| **↻ Replay** | Plays a finished run back cell by cell from the calls already on disk | Free, no model calls, ~9s |

**Replay exists so the run can be shown without re-running it.** It is playback of real
recorded calls, not new measurement: the server walks the stored records through the *same*
aggregation and emit path a live sweep uses, so the grid fills in exactly as it originally
did. A banner reads *"Replaying recorded calls — no new model calls are being made"* so it is
never mistaken for a live run. Adjust the speed with `?delay=<ms>` on
`/api/sweep/:id/replay` (default 55ms per call).

### Which run am I looking at?

The page opens on the **most complete** sweep, not merely the newest one — otherwise a quick
1-prompt test would replace the full grid with a nearly empty one. The header shows
`viewing run <id> · N prompts · N calls`, and the **Run** dropdown above the results table
switches between every sweep on disk. After you start a sweep, the view follows *that* run.

---

## What the data actually showed

Two independent runs of **8 prompts × 2 models × 10 reps = 160 calls** each (320 total).
Model A = `deepseek-v4-flash-0731`, Model B = `deepseek-v4.1-flash`, temperature 0.

| Prompt | Predicted | A det | B det | A reasoning | B reasoning |
| --- | --- | --- | --- | --- | --- |
| Exact recall — first 12 primes | green | 0.60 | 0.60 | 53 | 53 |
| Maths — 847 × 293 with steps | green | 0.60 | 0.70 | 168 | 195 |
| Spatial — 5×5 Markdown table | green | 0.70 | 0.90 | 343 | 328 |
| One-sentence explanation | green | 0.30 | 0.40 | 79 | 80 |
| ASCII cat, 5 lines | amber | 0.40 | 0.40 | 216 | 164 |
| Haiku about the ocean | red | **0.10** | **0.10** | 373 | 321 |
| Joke about programmers | red | **1.00** | 0.90 | 59 | 51 |
| Open creative — a city between sleeping and waking | red | **0.10** | **0.10** | **1390** | **1598** |

**The headline claim survives.** Creative and haiku prompts are red and tall, and the
open-creative cell is the tallest bar in the grid — ~1,400–1,600 reasoning tokens against ~50
for the joke. The expensive-and-unstable quadrant is real.

**Two predictions did not survive**, and the heatmap shows this plainly rather than hiding it:

1. **"Exact recall" is not deterministic.** The model always produced the correct twelve
   primes, but alternated between `2,3,5,...` and `2, 3, 5, ...` — a comma-spacing coin flip.
2. **Maths is not deterministic either.** The answer was always correct (248,171), but the
   working was formatted three different ways: `(847 × 200)` vs `847 × 200` vs `847×200`.

So the green column is not "closed-form questions". It is **"questions with exactly one
natural rendering"** — the Markdown table and the joke, both of which have a single strongly
conventional form. That is a more interesting and more defensible claim than the one the
experiment set out to confirm.

**Reproducibility:** Pearson **r = 0.93** across per-prompt determinism between the two runs.
Haiku and open-creative pinned at 0.10 both times; the joke was the most stable cell. Max
per-cell drift was 0.30, concentrated in the mid-range prompts. The *shape* of the landscape
is stable even where individual cells move.

**No model progression.** Across both runs the means are **0.494 (A)** vs **0.476 (B)** — a
0.018 gap, with B ahead in only 5 of 16 cells and 7 tied. This run does **not** show a clear
older-to-newer determinism progression. The interesting axis here is the **prompt**, not the
model.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BROWSER  ── Vite + React + TypeScript ── http://localhost:5173          │
│                                                                          │
│   App.tsx ──► SettingsPanel   (base URL, key, models, temp, reps)        │
│      │    ──► PromptEditor    (editable prompt list)                     │
│      │    ──► Overlay         (title, legend, progress, nonce audit)     │
│      │    ──► Tooltip         (hover: prompt, det, latency, tokens)      │
│      │    ──► ResultsTable    (per-cell numbers + JSONL export)          │
│      │                                                                   │
│      ├──► heatmap.ts   three.js InstancedMesh + OrbitControls + 2x PNG   │
│      └──► color.ts     Oklab perceptual ramp (green → amber → red)       │
│                                                                          │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │  fetch /api/*        SSE  /api/sweep/:id/stream
                             │                            /api/sweep/:id/replay
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SERVER  ── Hono + TypeScript ── http://localhost:3001                   │
│                                                                          │
│   index.ts    HTTP routes, SSE streaming, key resolution                 │
│   manager.ts  sequential sweep engine · SSE events · cancel · replay     │
│   provider.ts fetch → /chat/completions · retry · token accounting       │
│   nonce.ts    nonce generation + duplicate registry                      │
│   sweep.ts    defaults · aggregation · nonce audit                       │
│   store.ts    append-only JSONL · crash-tolerant reader                  │
│   audit.ts    independent re-derivation from raw JSONL                   │
│   cli-sweep.ts headless runs for verification                            │
│                                                                          │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │  sequential fetch (one call at a time)
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  PROVIDER  ── OpenAI-compatible  POST {baseUrl}/chat/completions         │
│                                                                          │
│   system: "You are a precise assistant. Answer the user's request        │
│            directly."                                                    │
│   user:   <prompt>                                                       │
│                                                                          │
│           <!--nonce:9f3ac41b7e0d2c85-->     ◄── fresh, unique, every call│
│                                                                          │
└────────────────────────────┬─────────────────────────────────────────────┘
                             │
                             ▼
                  server/data/sweeps.jsonl   (append-only, source of truth)
                             │
                             ▼
                  exports/  PNG + JSONL + manifest  (the evidence)
```

### Sweep lifecycle

```
POST /api/sweep
      │
      ├─► validate config ──► 400 with the provider's own error text
      │
      └─► manager.start() ──► sweepId, returns immediately
                │
                └─► run() ── sequential, one call at a time
                      │
                      for each prompt (8)
                        for each model slot (A, B)
                          for each rep (10)
                            ├─ nonce = registry.issue()      ◄─ asserted unique
                            ├─ callModel(cfg, model, prompt + nonce)
                            ├─ appendLines([record])         ◄─ durable immediately
                            └─ emit('progress' | 'cell')     ◄─ SSE to browser
                      │
                      └─► finish('complete' | 'cancelled' | 'error')
                            └─ appendLines([end marker])
```

### Data model

```ts
interface CallRecord {
  type: 'record';
  sweepId: string;
  promptId: string;  promptIndex: number;  promptLabel: string;
  model: string;     modelSlot: 'A' | 'B'; cellIndex: number;  rep: number;
  nonce: string;                 // unique per call — the anti-cache guarantee
  sha256: string;                // hash of `content`
  content: string;               // the raw response
  latencyMs: number;
  completionTokens: number;
  reasoningTokens: number;       // from usage.completion_tokens_details
  attempts: number;              // 2 if the empty-content retry fired
  maxTokensUsed: number;
  finishReason: string | null;
  error: string | null;
  ts: string;
}
```

> There is deliberately **no field that can hold `reasoning_content`**. The reasoning text is
> never read, stored, streamed or rendered — only its token count.

---

## How it works, with code

### 1. Nonces: the whole experiment hinges on this

Without a nonce, a provider-side response cache returns identical bytes for identical prompts
and the heatmap measures **the cache, not the model** — fake determinism. Every call appends a
fresh random nonce:

```ts
// server/src/sweep.ts
export function withNonce(base: string, nonce: string): string {
  return `${base}\n\n<!--nonce:${nonce}-->`;
}
```

The registry loops until it generates something never seen before, so a collision can only be
introduced by real reuse on disk — never by the generator:

```ts
// server/src/nonce.ts
issue(): string {
  for (let i = 0; i < 1000; i++) {
    const nonce = randomHex(8);
    if (!this.seen.has(nonce)) {
      this.seen.add(nonce);
      this.issuedCount++;
      return nonce;
    }
    this.duplicates.add(nonce);
  }
  throw new Error('nonce generation failed: 1000 consecutive collisions');
}
```

The registry is also **seeded from the persisted log** on startup, so uniqueness holds across
restarts and page reloads — not just within one process:

```ts
// server/src/manager.ts — recover()
for (const r of entry.records) this.nonces.observe(r.nonce);
```

### 2. Sequential calls and token accounting

Calls run **one at a time, never in parallel**. Concurrency distorts latency and token
accounting, and the entire point is that the numbers are trustworthy.

```ts
// server/src/manager.ts — run()
for (let rep = 0; rep < state.config.reps; rep++) {
  if (state.cancelRequested) return this.finish(state, 'cancelled');

  const nonce = this.nonces.issue();          // fresh, every single call
  const userContent = withNonce(prompt.text, nonce);
  const outcome = await callModel(state.config, model, userContent);
  // ...
}
```

Reasoning tokens come from exactly one place, with no fallback guessing:

```ts
// server/src/provider.ts
function extractReasoningTokens(json: ChatResponse): number {
  const n = json.usage?.completion_tokens_details?.reasoning_tokens;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}
```

**Empty-content retry.** A real failure mode: the model spends its entire budget on reasoning
and returns `content: ""` with `finish_reason: "length"`. We retry exactly once with double the
budget, then record a clear error rather than counting an empty string as "deterministic":

```ts
// server/src/provider.ts
if (content.trim().length > 0) {
  return { content, sha256: sha256(content), /* ... */ error: null };
}
// Empty content: retry once with double the budget.
lastError = `empty content (finish_reason=${lastFinish}, completion_tokens=${completionTokens})`;
maxTokens = maxTokens * 2;
```

**Honest error text.** The provider's own words are surfaced, never a generic message:

```ts
function providerErrorText(status: number, raw: string): string {
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    const err = parsed.error;
    if (typeof err === 'string') detail = err;
    else if (err && typeof err === 'object') {
      detail = [err.message, err.type, err.code].filter(Boolean).join(' — ') || raw;
    }
  } catch { /* body was not JSON; use it raw */ }
  return `HTTP ${status}: ${detail.slice(0, 600)}`;
}
```

### 3. Aggregation: determinism from sha256

```ts
// server/src/sweep.ts
export function aggregateCell(prompt, promptIndex, model, modelSlot, cellIndex, reps, records) {
  const ok = records.filter((r) => !r.error);          // errors excluded from the ratio
  const counts = new Map<string, number>();
  for (const r of ok) counts.set(r.sha256, (counts.get(r.sha256) ?? 0) + 1);

  let modalSha = null, modalCount = 0;
  for (const [sha, count] of counts) {
    if (count > modalCount) { modalCount = count; modalSha = sha; }
  }

  const denominator = ok.length || reps;
  return {
    determinismScore: denominator === 0 ? 0 : modalCount / denominator,
    distinctOutputs: counts.size,
    meanLatencyMs: Math.round(mean(ok.map((r) => r.latencyMs))),
    meanReasoningTokens: Math.round(mean(ok.map((r) => r.reasoningTokens))),
    // ...
  };
}
```

Errors are excluded from the denominator and reported separately, so **a provider outage can
never masquerade as determinism**.

### 4. Crash-safe JSONL storage

Every record is appended the moment it completes. Nothing is ever rewritten.

```ts
// server/src/store.ts
export async function appendLines(lines: JsonlLine[]): Promise<void> {
  if (lines.length === 0) return;
  await ensureDataDir();
  const payload = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await appendFile(JSONL_PATH, payload, 'utf8');
}
```

The reader tolerates a torn final line from a hard crash instead of corrupting the file:

```ts
for (const line of text.split('\n')) {
  if (!line.trim()) continue;
  let parsed: JsonlLine;
  try { parsed = JSON.parse(line); } catch { continue; }   // torn/partial write
  // ...
}
```

Recovery is **re-runnable**, so a sweep written by *another process* (a headless CLI run)
becomes visible without restarting the server:

```ts
async refreshIfEmpty(): Promise<void> {
  if (this.sweeps.size > 0) return;
  await this.recover();
}
```

### 5. Live progress over SSE

The sweep never looks frozen. A late subscriber gets a full snapshot first, so it is never
behind, and a heartbeat keeps proxies from idling the connection out:

```ts
// server/src/index.ts
return streamSSE(c, async (stream) => {
  await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(view) });

  await new Promise<void>((resolve) => {
    const unsubscribe = manager.subscribe(id, (event, payload) => {
      // The terminal `done` write MUST be awaited before resolving: the stream
      // closes as soon as this callback returns, and a dropped `done` makes
      // EventSource auto-reconnect — restarting the whole stream.
      void (async () => {
        try { await stream.writeSSE({ event, data: JSON.stringify(payload) }); }
        catch { /* client already gone */ }
        if (event === 'done') { clearInterval(heartbeat); unsubscribe(); resolve(); }
      })();
    });

    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: String(Date.now()) });
    }, 5000);

    stream.onAbort(() => { clearInterval(heartbeat); unsubscribe(); resolve(); });
  });
});
```

That comment is not hypothetical — see [Bugs this project found in itself](#bugs-this-project-found-in-itself).

### 6. The perceptual colour ramp

A naive HSL rainbow is banded and misleading. Interpolation happens in **Oklab**, which is
perceptually uniform, so the ramp reads as one continuous gradient:

```ts
// web/src/color.ts
const STOPS = [
  { t: 0.00, hex: '#e01b3c' },  // red    — model wanders
  { t: 0.34, hex: '#f2700f' },  // orange
  { t: 0.62, hex: '#f2b705' },  // amber
  { t: 0.84, hex: '#a8cf3a' },  // yellow-green
  { t: 1.00, hex: '#17c964' },  // green  — byte-identical every time
];

export function determinismToRgb(score: number): RGB {
  // find bracketing stops, interpolate in Oklab, convert back to sRGB
}
```

Rendering must match the legend, so tone mapping is **off**. Filmic tone mapping would
desaturate the cells and make the legend a lie:

```ts
// web/src/heatmap.ts
// No tone mapping: this is a data visualisation, so a cell's rendered colour
// must equal the ramp colour shown in the legend.
this.renderer.toneMapping = THREE.NoToneMapping;
```

### 7. The 3D grid

One `InstancedMesh` for the whole grid. Two column groups separated by a gap so the A-vs-B
comparison reads instantly:

```ts
// web/src/heatmap.ts
const GROUP_OFFSET = 1.25;   // half-distance between the two model columns
const COL_A = -GROUP_OFFSET;
const COL_B = GROUP_OFFSET;

const geometry = new THREE.BoxGeometry(CELL_W, 1, CELL_D);
geometry.translate(0, 0.5, 0);          // grow upward from the floor, not around centre

const material = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.12 });
this.mesh = new THREE.InstancedMesh(geometry, material, rows * 2);
this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
```

Per-instance height and colour, re-normalised as data streams in:

```ts
const maxTokens = Math.max(1, ...data.cells.map((c) => c.meanReasoningTokens));
const ratio = Math.min(1, cell.meanReasoningTokens / maxTokens);
const height = MIN_HEIGHT + ratio * MAX_HEIGHT;

matrix.makeScale(1, height, 1);
matrix.setPosition(x, 0, z);
mesh.setMatrixAt(i, matrix);
color.setRGB(r, g, b, THREE.SRGBColorSpace);
mesh.setColorAt(i, color);
```

Hover uses a raycast against the instanced mesh; `instanceId` *is* the cell index:

```ts
this.raycaster.setFromCamera(this.pointer, this.camera);
const hit = this.raycaster.intersectObject(this.mesh, false)[0];
const cell = this.data.cells[hit.instanceId];
```

Auto-rotate pauses while you drag and resumes once idle:

```ts
this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
this.controls.addEventListener('end', () => this.scheduleAutoRotate());  // 3.5s
```

### 8. The 2x PNG export

The export re-renders at 2x and composites the title, legend and audit line with the 2D API,
so the file is self-contained and crisp at 3200×2000:

```ts
exportPng(scale: number, meta: ExportMeta): string {
  this.renderer.setPixelRatio(1);
  this.renderer.setSize(cssW * scale, cssH * scale, false);
  this.renderer.render(this.scene, this.camera);

  const out = document.createElement('canvas');
  out.width = cssW * scale;
  out.height = cssH * scale;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(this.canvas, 0, 0, out.width, out.height);
  drawExportOverlay(ctx, out.width, out.height, scale, meta);

  // restore the interactive viewport
  this.renderer.setPixelRatio(prevPixelRatio);
  this.renderer.setSize(prevSize.x, prevSize.y, false);
  return out.toDataURL('image/png');
}
```

This requires `preserveDrawingBuffer: true` on the renderer so the framebuffer can be read back.

---

## API reference

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, JSONL path, `hasServerKey` |
| `GET` | `/api/defaults` | Default config, prompt set, `hasServerKey` |
| `GET` | `/api/sweeps` | All sweeps on disk + latest id |
| `GET` | `/api/sweep/latest` | Re-attach after a page reload |
| `GET` | `/api/sweep/:id` | Full sweep state + aggregates |
| `POST` | `/api/sweep` | Start a sweep: `{ prompts[], reps, config }` |
| `GET` | `/api/sweep/:id/stream` | SSE: `snapshot`, `progress`, `record`, `cell`, `status`, `done`, `ping` |
| `GET` | `/api/sweep/:id/replay` | SSE replay of recorded calls (`?delay=<ms>`) |
| `POST` | `/api/sweep/:id/cancel` | Abort cleanly, keeping every completed record |
| `GET` | `/api/export/jsonl` | Download the raw records |

> Route order matters: `/api/sweep/latest` is registered **before** `/api/sweep/:id`,
> otherwise the parameterised route swallows it and treats `"latest"` as an id.

---

## Verification

Everything below is reproducible from the committed artifacts in `exports/`.

```bash
pnpm sweep --reps 10 --label run1
pnpm sweep --reps 10 --label run2
pnpm audit                        # re-derives every claim from the raw JSONL
pnpm verify:ui                    # drives the real UI, hovers a cell, exports the PNG
pnpm verify:png                   # reads the exported bitmap back
pnpm export:evidence              # bundles PNG + JSONL + manifest
```

`pnpm audit` re-reads `sweeps.jsonl` and independently checks:

| # | Claim | Result |
| --- | --- | --- |
| 1 | Every call carries a unique nonce | **PASS** — 320 calls, 320 distinct nonces, 0 reused |
| 2 | Determinism derives from real sha256 of responses | **PASS** — 320/320 stored hashes match recomputed hashes |
| 3 | Reasoning tokens from `usage.completion_tokens_details.reasoning_tokens` | **PASS** — 320/320 well-formed |
| 4 | `reasoning_content` never stored | **PASS** — absent from every record and from the raw file text |

`pnpm verify:png` reads the exported bitmap back and asserts it is a readable artifact rather
than a blank canvas: both ends of the colour ramp are present (green deterministic cells *and*
red unstable cells), the mid-ramp appears, and text pixels are actually drawn in the title,
legend and audit regions.

**The nonce check is not decorative.** Injecting a duplicate nonce into a copy of the log makes
the audit print `FAIL — determinism numbers are invalid and must be discarded` and exit `1`:

```bash
# negative control: force two records to share a nonce, then re-audit
pnpm -C server audit --jsonl /tmp/dup-test.jsonl   # exit code 1
```

---

## Bugs this project found in itself

Six real defects, each caught only by running the system rather than assuming it worked.

**1. `/api/sweep/latest` was shadowed by `/api/sweep/:id`.** Hono matches in registration
order, so the route resolved with `id="latest"` and page reloads silently failed to re-attach.
Fixed by registering the literal route first.

**2. Recovery only ran at startup.** A sweep written to the log by a *separate process* (a
headless CLI run) was invisible to the running server. Fixed with a re-runnable `recover()`
plus `refreshIfEmpty()` on the read routes.

**3. Tone mapping desaturated the cells.** ACES filmic tone mapping made rendered cell colours
differ from the legend's true ramp — the legend was effectively lying. Removed in favour of
`NoToneMapping`. Green pixels went from 237 to 6,551 after the fix, which is how the bug was
found: a pixel-level assertion that green cells must be present.

**4. The CLI printed determinism after rep 1**, where one sample is trivially identical to
itself and always reads `1.00`. It now waits for all reps before reporting a cell.

**5. A dropped `done` event caused an infinite replay loop.** The terminal event was written
with `void stream.writeSSE(...)` — not awaited. The stream closed the instant the handler
returned, so `done` never flushed; EventSource saw the connection drop and auto-reconnected,
**restarting the replay forever**. It looked like a hung UI. Fixed by awaiting the write before
resolving, in both the live and replay routes.

**6. A type error made a fix silently do nothing.** `SweepView.cells` is an *array*, not a
count, so `best.cells > target.cells` compared a number to an array and was always `false`.
The page still *rendered* fine — exactly the kind of bug that ships silently. It needed
`target.totalCells`.

---

## Forking and contributing

### Fork and run locally

```bash
git clone https://github.com/harishkotra/determinism-heatmap.git
cd determinism-heatmap
pnpm install
pnpm start
```

Point it at any OpenAI-compatible endpoint via **⚙ Settings** — the base URL, API key and both
model names are all editable and persisted to `localStorage`. Nothing is hardcoded.

### Project layout

```
server/src/
  index.ts       HTTP routes, SSE, key resolution     ← add endpoints here
  manager.ts     sweep engine, events, cancel, replay ← change orchestration here
  provider.ts    the single model call                ← change request shape here
  nonce.ts       nonce generation + registry
  sweep.ts       defaults, aggregation, audit         ← change the metric here
  store.ts       JSONL append + recovery
  audit.ts       independent verification
  cli-sweep.ts   headless runner

web/src/
  App.tsx        state machine, SSE wiring, localStorage
  heatmap.ts     three.js scene + PNG export          ← change the visual here
  color.ts       Oklab ramp                           ← change the palette here
  Overlay.tsx    title, legend, progress, audit, credit
  SettingsPanel.tsx / PromptEditor.tsx / ResultsTable.tsx / Tooltip.tsx
  author.ts      attribution constants
```

### Ground rules

These are the invariants that make the numbers meaningful. A PR that breaks one of them makes
the heatmap a lie:

1. **Never remove the nonce.** Any change that lets two calls share a prompt without a unique
   nonce invalidates the experiment.
2. **Never store `reasoning_content`.** Only the token count. `CallRecord` has no field for it
   on purpose.
3. **Never parallelise the calls** without saying so loudly. Sequential execution is what makes
   latency and token numbers comparable.
4. **Never count an error as determinism.** Errors are excluded from the denominator and
   reported separately.
5. **Keep the legend honest.** If you change how cells are coloured, the legend must change
   with them — and tone mapping stays off.

### Adding a new metric

The cleanest extension point is `aggregateCell` in `server/src/sweep.ts`:

```ts
export function aggregateCell(...): CellAggregate {
  // add e.g. a normalised hash that ignores whitespace/case
  const normalized = ok.map((r) => sha256(r.content.replace(/\s+/g, ' ').trim().toLowerCase()));
  // ...then expose it on CellAggregate and surface it in Tooltip.tsx
}
```

Then add the field to `CellAggregate` in **both** `server/src/types.ts` and `web/src/types.ts`,
and render it in `Tooltip.tsx` / `ResultsTable.tsx`. The audit will pick it up automatically if
you extend `audit.ts`.

### Adding a new chart type

`heatmap.ts` is self-contained: construct it with a canvas and an `onHover` callback, call
`setData({ prompts, cells, reps, modelA, modelB })` whenever data changes, and it handles
resize, raycasting, auto-rotate and export. Swap the geometry or add a second `InstancedMesh`
without touching React.

### Testing your change

```bash
pnpm -C server audit          # invariants still hold
pnpm verify:ui                # UI still renders and exports
pnpm verify:png               # the exported image is still readable
```

If you touch the sweep engine, run a real sweep at low reps first:

```bash
pnpm sweep --reps 2 --label smoke
```

---

## Feature ideas

Good first issues, roughly in ascending difficulty.

**Measurement**
- **Temperature sweep** — run the same prompts at 0, 0.3, 0.7, 1.0 and render temperature as a
  third axis. The obvious next experiment, and the fastest way to make the red column appear.
- **Semantic determinism** — a second score computed over a normalised hash (whitespace, case,
  punctuation) shown alongside the byte-exact one. Directly explains why maths scores 0.60
  despite always being correct.
- **Confidence intervals** — with `reps = 10` a score of 0.60 has real uncertainty. Add a
  Wilson interval and encode it as bar opacity or a whisker.
- **More models** — widen the grid to N columns. `CELLS_PER_PROMPT` and the column layout in
  `heatmap.ts` are the two places to change.
- **Prompt sets as files** — load a prompt suite from JSON/YAML so experiments are shareable
  and versioned.
- **Cost accounting** — multiply tokens by per-model pricing and show a cost axis. "Expensive
  and unstable" becomes literal money.

**Visualisation**
- **Diff view** — click a red cell to see the N distinct outputs side by side with a character
  diff. This is the most requested thing a heatmap makes you want.
- **Animated transitions** — tween bar heights when switching sweeps instead of snapping.
- **Time-series mode** — plot determinism across model versions to show a regression or
  improvement over time.
- **VR / WebXR** — walk the landscape. Genuinely useful at 100+ prompts.
- **Shareable URL state** — encode sweep id, camera angle and filters in the query string.

**Infrastructure**
- **Postgres/SQLite backend** — the JSONL is deliberately simple; swap `store.ts` for a real
  store when you outgrow it. The interface is four functions.
- **Resumable sweeps** — restart an interrupted sweep from where it stopped, using the records
  already on disk.
- **Rate-limit handling** — exponential backoff with jitter and a concurrency budget.
- **Multi-provider comparison** — run the same prompts against OpenAI, Anthropic and a local
  model, then colour by provider instead of model slot.
- **CI verification** — run `pnpm audit` in GitHub Actions on every PR and fail if the nonce
  invariant breaks.

---

## Caveats

- **Temperature 0 is an upper bound.** The default sweep runs at temperature 0, the most
  favourable case for determinism. Real deployments run warmer and will score lower. The UI
  states this on screen.
- Determinism here means **byte-identical output**, a strict bar. Two responses differing only
  in trailing whitespace count as different — which is exactly why "exact recall" scores 0.60
  rather than 1.00.
- Scores are computed over successful calls; errors are excluded from the ratio and reported
  separately. In run 1 one creative cell hit this path: the model burned its entire budget on
  reasoning and returned empty content even after the doubled retry, and was recorded as an
  error rather than as a deterministic empty string.
- These numbers are specific to `deepseek-v4-flash-0731` and `deepseek-v4.1-flash` at
  temperature 0, and **do not show a clear older-to-newer progression** (0.494 vs 0.476).
- `server/data/sweeps.jsonl` contains every run, including small test sweeps. The **Run**
  dropdown lists them all.

---

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Vite + React 18 + TypeScript | Fast HMR; typed contracts between server and UI |
| 3D | three.js (`InstancedMesh`, `OrbitControls`) | One draw call for the whole grid; per-instance colour and height |
| Colour | Hand-rolled Oklab | Perceptually uniform ramp; no dependency needed for ~80 lines |
| Backend | Hono + `@hono/node-server` | Tiny, fast, first-class SSE via `streamSSE` |
| Model calls | plain `fetch` | No SDK — the request shape stays visible and auditable |
| Storage | Append-only JSONL | Survives crashes, greppable, diffable, no database |
| Verification | Playwright + pixel assertions | Proves the UI and the exported PNG actually work |

No auth, no database, no deployment, no chat UI, no multi-turn, no external APIs or search.