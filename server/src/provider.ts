import { createHash } from 'node:crypto';
import type { SweepConfig } from './types.js';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface CallOutcome {
  content: string;
  sha256: string;
  latencyMs: number;
  completionTokens: number;
  reasoningTokens: number;
  attempts: number;
  maxTokensUsed: number;
  finishReason: string | null;
  error: string | null;
}

export class ProviderError extends Error {}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: unknown;
}

function extractReasoningTokens(json: ChatResponse): number {
  const n = json.usage?.completion_tokens_details?.reasoning_tokens;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * Pull the provider's real error text out of a non-2xx body so the UI can show
 * it verbatim instead of a generic message.
 */
function providerErrorText(status: number, raw: string): string {
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const err = parsed.error;
    if (typeof err === 'string') detail = err;
    else if (err && typeof err === 'object') {
      const e = err as { message?: unknown; type?: unknown; code?: unknown };
      detail = [e.message, e.type, e.code].filter(Boolean).map(String).join(' — ') || raw;
    } else if (typeof parsed.message === 'string') detail = parsed.message;
  } catch {
    /* body was not JSON; use it raw */
  }
  return `HTTP ${status}: ${detail.slice(0, 600)}`;
}

/**
 * One measured call.
 *
 * The prompt carries a unique nonce supplied by the caller. We never read,
 * store, log or return `reasoning_content` — only the token count from
 * `usage.completion_tokens_details.reasoning_tokens`.
 *
 * If the model returns empty content (a real failure mode when the whole
 * budget is consumed by reasoning), we retry exactly once with a doubled
 * token budget.
 */
export async function callModel(
  cfg: SweepConfig,
  model: string,
  userContent: string,
): Promise<CallOutcome> {
  let maxTokens = cfg.maxTokens;
  let attempts = 0;
  let lastError: string | null = null;
  let lastFinish: string | null = null;
  let completionTokens = 0;
  let reasoningTokens = 0;
  const startedAt = Date.now();

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: cfg.systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: cfg.temperature,
      max_tokens: maxTokens,
    };
    if (cfg.disableReasoning) {
      body.chat_template_kwargs = { enable_thinking: false };
    }

    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      lastError = `network: ${(err as Error).message}`;
      break; // network failure: retrying with a bigger budget will not help
    }

    const raw = await res.text();
    if (!res.ok) {
      // Surface the provider's own words.
      lastError = providerErrorText(res.status, raw);
      break;
    }

    let json: ChatResponse;
    try {
      json = JSON.parse(raw) as ChatResponse;
    } catch {
      lastError = `invalid JSON from provider: ${raw.slice(0, 200)}`;
      break;
    }

    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? '';
    lastFinish = choice?.finish_reason ?? null;
    completionTokens = json.usage?.completion_tokens ?? 0;
    reasoningTokens = extractReasoningTokens(json);

    if (content.trim().length > 0) {
      return {
        content,
        sha256: sha256(content),
        latencyMs: Date.now() - startedAt,
        completionTokens,
        reasoningTokens,
        attempts,
        maxTokensUsed: maxTokens,
        finishReason: lastFinish,
        error: null,
      };
    }

    // Empty content: retry once with double the budget.
    lastError = `empty content (finish_reason=${lastFinish ?? 'null'}, completion_tokens=${completionTokens})`;
    maxTokens = maxTokens * 2;
  }

  return {
    content: '',
    sha256: sha256(''),
    latencyMs: Date.now() - startedAt,
    completionTokens,
    reasoningTokens,
    attempts,
    maxTokensUsed: maxTokens,
    finishReason: lastFinish,
    error: lastError ?? 'unknown failure',
  };
}