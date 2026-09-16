/** Shared server-side types. Kept free of any `reasoning_content` field by construction. */

export type ModelSlot = 'A' | 'B';

export interface SweepConfig {
  baseUrl: string;
  apiKey: string;
  modelA: string;
  modelB: string;
  temperature: number;
  maxTokens: number;
  reps: number;
  disableReasoning: boolean;
  systemPrompt: string;
}

export interface PromptDef {
  id: string;
  label: string;
  text: string;
}

/**
 * One measured call. NOTE: this shape deliberately has no field that can hold
 * `reasoning_content`; only its token count is ever retained.
 */
export interface CallRecord {
  type: 'record';
  sweepId: string;
  promptId: string;
  promptIndex: number;
  promptLabel: string;
  model: string;
  modelSlot: ModelSlot;
  cellIndex: number;
  rep: number;
  nonce: string;
  sha256: string;
  content: string;
  latencyMs: number;
  completionTokens: number;
  reasoningTokens: number;
  attempts: number;
  maxTokensUsed: number;
  finishReason: string | null;
  error: string | null;
  ts: string;
}

export interface SweepMeta {
  type: 'meta';
  sweepId: string;
  startedAt: string;
  /** apiKey is never written to disk. */
  config: Omit<SweepConfig, 'apiKey'>;
  prompts: PromptDef[];
}

/** Written once when a sweep ends, so a recovered sweep keeps its real status. */
export interface SweepEnd {
  type: 'end';
  sweepId: string;
  status: Extract<SweepStatus, 'complete' | 'cancelled' | 'error'>;
  finishedAt: string;
  error: string | null;
  calls: number;
}

export type JsonlLine = CallRecord | SweepMeta | SweepEnd;

export interface CellAggregate {
  cellIndex: number;
  promptIndex: number;
  promptId: string;
  promptLabel: string;
  promptText: string;
  model: string;
  modelSlot: ModelSlot;
  reps: number;
  okCount: number;
  errorCount: number;
  /** count(modal sha256) / reps over successful calls. */
  determinismScore: number;
  modalSha: string | null;
  distinctOutputs: number;
  meanLatencyMs: number;
  meanReasoningTokens: number;
  meanCompletionTokens: number;
  totalReasoningTokens: number;
}

export type SweepStatus = 'idle' | 'sweeping' | 'complete' | 'cancelled' | 'error';

export interface SweepProgress {
  cellIndex: number;
  totalCells: number;
  rep: number;
  totalReps: number;
  promptLabel: string;
  model: string;
  modelSlot: ModelSlot;
}

export interface NonceAudit {
  issued: number;
  unique: number;
  duplicates: string[];
  ok: boolean;
}

export interface SweepView {
  id: string;
  status: SweepStatus;
  startedAt: string;
  finishedAt: string | null;
  config: Omit<SweepConfig, 'apiKey'>;
  prompts: PromptDef[];
  totalCells: number;
  completedCells: number;
  totalCalls: number;
  completedCalls: number;
  progress: SweepProgress | null;
  error: string | null;
  nonceAudit: NonceAudit;
  cells: CellAggregate[];
  records: CallRecord[];
}