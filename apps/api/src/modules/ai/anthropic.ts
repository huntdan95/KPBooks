/**
 * Thin Anthropic Messages API client. We use raw fetch rather than @anthropic-ai/sdk
 * to avoid pulling a dependency for a single endpoint. The Cloud Run service
 * mounts the API key from the kpbooks-anthropic-api-key Secret Manager secret.
 *
 * If ANTHROPIC_API_KEY is unset (e.g. local dev without a key), the client
 * throws on call -- callers should check isAvailable() first and fall back
 * to a manual workflow.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicCallOptions {
  system?: string;
  messages: AnthropicMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AnthropicResponse {
  text: string;
  stopReason?: string | undefined;
  usage?: { inputTokens: number; outputTokens: number };
}

export class AnthropicError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AnthropicError';
  }
}

export function isAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function callAnthropic(opts: AnthropicCallOptions): Promise<AnthropicResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AnthropicError('ANTHROPIC_API_KEY env var is not set');
  }

  const body = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 0,
    system: opts.system,
    messages: opts.messages,
  };

  const res = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new AnthropicError(
      `Anthropic API ${res.status}: ${detail.slice(0, 500)}`,
      res.status,
    );
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };

  // The Messages API returns a content array; we only expect a single text block.
  const textBlock = (json.content ?? []).find((b) => b.type === 'text');
  const text = textBlock?.text ?? '';
  const result: AnthropicResponse = { text };
  if (json.stop_reason !== undefined) result.stopReason = json.stop_reason;
  if (json.usage) {
    result.usage = {
      inputTokens: json.usage.input_tokens,
      outputTokens: json.usage.output_tokens,
    };
  }
  return result;
}

/**
 * Strip a fenced code block if Claude wraps JSON in ```json ... ```.
 * Useful when the system prompt asks for raw JSON but the model still
 * fences it.
 */
export function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return match?.[1]?.trim() ?? trimmed;
}
