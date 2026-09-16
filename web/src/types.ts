export type ModelSlot = 'A' | 'B';

export interface PromptDef {
  id: string;
  label: string;
  text: string;
}

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
  config: {
    baseUrl: string;
    modelA: string;
    modelB: string;
    temperature: number;
    maxTokens: number;
    reps: number;
    disableReasoning: boolean;
    systemPrompt: string;
  };
  prompts: PromptDef[];
  totalCells: number;
  completedCells: number;
  totalCalls: number;
  completedCalls: number;
  progress: SweepProgress | null;
  error: string | null;
  nonceAudit: NonceAudit;
  cells: CellAggregate[];
  records: Array<{ cellIndex: number; nonce: string; error: string | null }>;
}

export interface Settings {
  baseUrl: string;
  apiKey: string;
  modelA: string;
  modelB: string;
  temperature: number;
  maxTokens: number;
  reps: number;
  disableReasoning: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.particle.ai/v1',
  apiKey: '',
  modelA: 'deepseek-v4-flash-0731',
  modelB: 'deepseek-v4.1-flash',
  temperature: 0,
  maxTokens: 1600,
  reps: 10,
  disableReasoning: false,
};