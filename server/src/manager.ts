import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { NonceRegistry } from './nonce.js';
import { callModel } from './provider.js';
import { appendLines, readAllSweeps } from './store.js';
import {
  aggregateCell,
  auditNonces,
  DEFAULT_SYSTEM_PROMPT,
  redactConfig,
  withNonce,
} from './sweep.js';
import type {
  CallRecord,
  CellAggregate,
  PromptDef,
  SweepConfig,
  SweepMeta,
  SweepProgress,
  SweepStatus,
  SweepView,
} from './types.js';

export interface SweepEvents {
  progress: SweepProgress;
  record: CallRecord;
  cell: CellAggregate;
  /** Replay only: clears the grid so the fill-in is visible. */
  reset: CellAggregate[];
  status: SweepStatus;
  done: SweepView;
}

interface SweepState {
  id: string;
  status: SweepStatus;
  startedAt: string;
  finishedAt: string | null;
  config: SweepConfig;
  prompts: PromptDef[];
  records: CallRecord[];
  cells: CellAggregate[];
  progress: SweepProgress | null;
  error: string | null;
  cancelRequested: boolean;
  emitter: EventEmitter;
}

const CELLS_PER_PROMPT = 2;

export class SweepManager {
  private readonly sweeps = new Map<string, SweepState>();
  private readonly nonces = new NonceRegistry();
  private readonly replaying = new Set<string>();
  private activeId: string | null = null;

  /**
   * Rebuild state from the append-only JSONL so reloads and restarts recover.
   *
   * Safe to call repeatedly: it is re-run on demand (see `refresh`) so that a
   * sweep written to the log by *another process* — a headless CLI run, or a
   * server that was restarted mid-sweep — becomes visible without a restart.
   * Sweeps this process is actively running are never clobbered.
   */
  async recover(): Promise<void> {
    const recovered = await readAllSweeps();
    for (const [id, entry] of recovered) {
      for (const r of entry.records) this.nonces.observe(r.nonce);

      const existing = this.sweeps.get(id);
      // A live run owns its own state; only its own code may mutate it.
      if (existing && existing.status === 'sweeping') continue;

      const cells = this.buildCells(entry.meta.prompts, entry.meta.config, entry.records);

      // The end marker on disk is authoritative. Without one the sweep was
      // interrupted — unless every expected call is present, in which case it
      // plainly ran to completion and labelling it "cancelled" would be wrong.
      const expectedCalls =
        entry.meta.prompts.length * CELLS_PER_PROMPT * entry.meta.config.reps;
      const inferredStatus: SweepStatus =
        entry.records.length >= expectedCalls && expectedCalls > 0 ? 'complete' : 'cancelled';

      this.sweeps.set(id, {
        id,
        status: existing?.status ?? entry.end?.status ?? inferredStatus,
        startedAt: entry.meta.startedAt,
        finishedAt: existing?.finishedAt ?? entry.end?.finishedAt ?? null,
        config: { ...entry.meta.config, apiKey: '' },
        prompts: entry.meta.prompts,
        records: entry.records,
        cells,
        progress: null,
        error: existing?.error ?? entry.end?.error ?? null,
        cancelRequested: false,
        emitter: existing?.emitter ?? new EventEmitter(),
      });
    }
  }

  /**
   * Re-read the log if this process has no sweeps of its own, so the UI picks
   * up headless runs without a server restart.
   */
  async refreshIfEmpty(): Promise<void> {
    if (this.sweeps.size > 0) return;
    await this.recover();
  }

  private buildCells(
    prompts: PromptDef[],
    config: Omit<SweepConfig, 'apiKey'>,
    records: CallRecord[],
  ): CellAggregate[] {
    const cells: CellAggregate[] = [];
    for (let p = 0; p < prompts.length; p++) {
      const prompt = prompts[p]!;
      for (let slot = 0; slot < CELLS_PER_PROMPT; slot++) {
        const modelSlot = slot === 0 ? 'A' : 'B';
        const model = slot === 0 ? config.modelA : config.modelB;
        const cellIndex = p * CELLS_PER_PROMPT + slot;
        const cellRecords = records.filter((r) => r.cellIndex === cellIndex);
        cells.push(
          aggregateCell(prompt, p, model, modelSlot, cellIndex, config.reps, cellRecords),
        );
      }
    }
    return cells;
  }

  /** Most recent sweep id, so a reloaded page can re-attach to its stream. */
  latestId(): string | null {
    if (this.activeId) return this.activeId;
    let best: { id: string; startedAt: string } | null = null;
    for (const s of this.sweeps.values()) {
      if (!best || s.startedAt > best.startedAt) best = { id: s.id, startedAt: s.startedAt };
    }
    return best?.id ?? null;
  }

  get(id: string): SweepState | undefined {
    return this.sweeps.get(id);
  }

  isReplaying(id: string): boolean {
    return this.replaying.has(id);
  }

  /**
   * Replay a finished sweep's *recorded* calls through the same emit path a
   * live run uses, so the grid fills in cell by cell exactly as it did
   * originally. Nothing is re-measured and no tokens are spent — this is a
   * visualisation of real stored records, not a new experiment.
   *
   * Cells are rebuilt incrementally from the records seen so far, so a
   * half-filled cell shows the same partial determinism a live run would.
   */
  async replay(id: string, delayMs = 55): Promise<boolean> {
    const state = this.sweeps.get(id);
    if (!state || state.status === 'sweeping' || this.replaying.has(id)) return false;

    this.replaying.add(id);
    const cfg = redactConfig(state.config);
    const totalCells = state.prompts.length * CELLS_PER_PROMPT;

    try {
      // Clear the grid first so the fill-in is actually visible.
      this.emit(state, 'reset', this.buildCells(state.prompts, cfg, []));

      const seen: CallRecord[] = [];
      const cells = this.buildCells(state.prompts, cfg, []);

      for (const record of state.records) {
        seen.push(record);
        const prompt = state.prompts[record.promptIndex];
        if (!prompt) continue;

        const cell = aggregateCell(
          prompt,
          record.promptIndex,
          record.model,
          record.modelSlot,
          record.cellIndex,
          state.config.reps,
          seen.filter((r) => r.cellIndex === record.cellIndex),
        );
        cells[record.cellIndex] = cell;

        this.emit(state, 'progress', {
          cellIndex: record.cellIndex,
          totalCells,
          rep: record.rep + 1,
          totalReps: state.config.reps,
          promptLabel: record.promptLabel,
          model: record.model,
          modelSlot: record.modelSlot,
        } satisfies SweepProgress);
        this.emit(state, 'cell', cell);

        await new Promise((r) => setTimeout(r, delayMs));
      }

      const view = this.view(id);
      if (view) this.emit(state, 'done', { ...view, cells });
      return true;
    } finally {
      this.replaying.delete(id);
    }
  }

  subscribe(id: string, listener: (event: keyof SweepEvents, payload: unknown) => void): () => void {
    const state = this.sweeps.get(id);
    if (!state) return () => {};
    const handler = (event: keyof SweepEvents, payload: unknown) => listener(event, payload);
    state.emitter.on('event', handler);
    return () => state.emitter.off('event', handler);
  }

  private emit(state: SweepState, event: keyof SweepEvents, payload: unknown): void {
    state.emitter.emit('event', event, payload);
  }

  view(id: string): SweepView | null {
    const state = this.sweeps.get(id);
    if (!state) return null;
    const totalCells = state.prompts.length * CELLS_PER_PROMPT;
    const completedCells = state.cells.filter((c) => c.okCount + c.errorCount >= state.config.reps).length;
    return {
      id: state.id,
      status: state.status,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      config: redactConfig(state.config),
      prompts: state.prompts,
      totalCells,
      completedCells,
      totalCalls: totalCells * state.config.reps,
      completedCalls: state.records.length,
      progress: state.progress,
      error: state.error,
      nonceAudit: auditNonces(state.records),
      cells: state.cells,
      records: state.records,
    };
  }

  list(): Array<{ id: string; status: SweepStatus; startedAt: string; cells: number }> {
    return [...this.sweeps.values()].map((s) => ({
      id: s.id,
      status: s.status,
      startedAt: s.startedAt,
      cells: s.cells.length,
    }));
  }

  cancel(id: string): boolean {
    const state = this.sweeps.get(id);
    if (!state || state.status !== 'sweeping') return false;
    state.cancelRequested = true;
    return true;
  }

  /**
   * Start a sweep. Calls run strictly sequentially — one at a time — so that
   * latency and token measurements are not distorted by concurrency.
   */
  start(input: {
    prompts: PromptDef[];
    reps: number;
    config: Partial<SweepConfig>;
  }): string {
    const id = randomUUID();
    const prompts = input.prompts.length
      ? input.prompts
      : [{ id: 'p0', label: 'Prompt 1', text: 'Say hello.' }];

    const config: SweepConfig = {
      baseUrl: input.config.baseUrl ?? 'https://api.particle.ai/v1',
      apiKey: input.config.apiKey ?? '',
      modelA: input.config.modelA ?? 'deepseek-v4-flash-0731',
      modelB: input.config.modelB ?? 'deepseek-v4.1-flash',
      temperature: input.config.temperature ?? 0,
      maxTokens: input.config.maxTokens ?? 1600,
      reps: input.reps,
      disableReasoning: input.config.disableReasoning ?? false,
      systemPrompt: input.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    };

    const state: SweepState = {
      id,
      status: 'sweeping',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      config,
      prompts,
      records: [],
      cells: this.buildCells(prompts, redactConfig(config), []),
      progress: null,
      error: null,
      cancelRequested: false,
      emitter: new EventEmitter(),
    };
    this.sweeps.set(id, state);
    this.activeId = id;

    void this.run(state);
    return id;
  }

  private async run(state: SweepState): Promise<void> {
    const meta: SweepMeta = {
      type: 'meta',
      sweepId: state.id,
      startedAt: state.startedAt,
      config: redactConfig(state.config),
      prompts: state.prompts,
    };
    await appendLines([meta]);
    this.emit(state, 'status', state.status);

    try {
      for (let p = 0; p < state.prompts.length; p++) {
        const prompt = state.prompts[p]!;
        for (let slot = 0; slot < CELLS_PER_PROMPT; slot++) {
          const modelSlot = slot === 0 ? 'A' : 'B';
          const model = slot === 0 ? state.config.modelA : state.config.modelB;
          const cellIndex = p * CELLS_PER_PROMPT + slot;

          for (let rep = 0; rep < state.config.reps; rep++) {
            if (state.cancelRequested) return this.finish(state, 'cancelled');

            // Fresh nonce for every single call. Asserted unique by the registry.
            const nonce = this.nonces.issue();
            const userContent = withNonce(prompt.text, nonce);

            state.progress = {
              cellIndex,
              totalCells: state.prompts.length * CELLS_PER_PROMPT,
              rep: rep + 1,
              totalReps: state.config.reps,
              promptLabel: prompt.label,
              model,
              modelSlot,
            };
            this.emit(state, 'progress', state.progress);

            const outcome = await callModel(state.config, model, userContent);

            const record: CallRecord = {
              type: 'record',
              sweepId: state.id,
              promptId: prompt.id,
              promptIndex: p,
              promptLabel: prompt.label,
              model,
              modelSlot,
              cellIndex,
              rep,
              nonce,
              sha256: outcome.sha256,
              content: outcome.content,
              latencyMs: outcome.latencyMs,
              completionTokens: outcome.completionTokens,
              reasoningTokens: outcome.reasoningTokens,
              attempts: outcome.attempts,
              maxTokensUsed: outcome.maxTokensUsed,
              finishReason: outcome.finishReason,
              error: outcome.error,
              ts: new Date().toISOString(),
            };

            state.records.push(record);
            await appendLines([record]);

            const cellRecords = state.records.filter((r) => r.cellIndex === cellIndex);
            const cell = aggregateCell(
              prompt,
              p,
              model,
              modelSlot,
              cellIndex,
              state.config.reps,
              cellRecords,
            );
            state.cells[cellIndex] = cell;

            this.emit(state, 'record', record);
            this.emit(state, 'cell', cell);
          }
        }
      }
      return this.finish(state, 'complete');
    } catch (err) {
      state.error = (err as Error).message;
      return this.finish(state, 'error');
    }
  }

  private finish(state: SweepState, status: SweepStatus): void {
    state.status = status;
    state.finishedAt = new Date().toISOString();
    state.progress = null;

    // Persist the terminal status so a later restart recovers the truth rather
    // than guessing. Fire-and-forget: the in-memory result is already correct.
    void appendLines([
      {
        type: 'end',
        sweepId: state.id,
        status: status as 'complete' | 'cancelled' | 'error',
        finishedAt: state.finishedAt,
        error: state.error,
        calls: state.records.length,
      },
    ]).catch(() => {});

    this.emit(state, 'status', status);
    const view = this.view(state.id);
    if (view) this.emit(state, 'done', view);
  }
}