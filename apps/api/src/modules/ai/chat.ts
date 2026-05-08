/**
 * Chat-with-your-books service. Wraps Anthropic's Messages API with a set
 * of read-only tools mapped to the existing report + list services. The
 * caller sends the conversation; we run a tool-use loop on the server (RLS-
 * scoped to the company), then return the final assistant text + a record
 * of tool calls so the UI can show "Claude looked up X" breadcrumbs.
 *
 * Read-only by design: no tool can mutate state. All side effects stay in
 * dedicated routes the user invokes explicitly. This avoids the LLM-creates-
 * a-bad-invoice failure mode and keeps the chat path safe to expose under
 * any role.
 */
import {
  type Database,
  accounts,
  bills,
  customers,
  invoices,
  payments,
  vendors,
} from '@kpbooks/db';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import {
  apAging,
  arAging,
  balanceSheet,
  profitAndLoss,
  trialBalance,
} from '../ledger/reports.service.js';
import {
  AnthropicError,
  callAnthropic,
  isAvailable as anthropicAvailable,
} from './anthropic.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOOL_ITERATIONS = 10;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatToolCall {
  name: string;
  input: Record<string, unknown>;
  /** JSON-stringified tool result (what we sent back to Claude). */
  result: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Optional override; defaults to claude-haiku. */
  model?: string | undefined;
}

export interface ChatResponse {
  reply: string;
  toolCalls: ChatToolCall[];
  /** Stop reason from the final Anthropic response: end_turn / max_tokens / etc. */
  stopReason?: string | undefined;
  /** True if we hit MAX_TOOL_ITERATIONS without the model returning end_turn. */
  iterationLimitReached: boolean;
}

export interface ChatContext {
  companyId: string;
  userId: string;
}

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly code: 'ai_unavailable' | 'ai_failed' | 'invalid_input',
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

// ---------------------------- Tool definitions -----------------------------

/**
 * Each tool has:
 *   - schema: what we send Claude so it knows when/how to call it
 *   - run: server-side executor; gets the company-scoped tx and returns JSON
 *
 * Schemas use Anthropic's JSONSchema format. Keep input shapes flat -- Claude
 * follows them faithfully, and a flat shape means the descriptions can sit
 * right next to each field.
 */
type ToolRunner = (
  tx: Database,
  input: Record<string, unknown>,
) => Promise<unknown>;

interface ToolDef {
  schema: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
  run: ToolRunner;
}

const dateField = {
  type: 'string',
  description: 'YYYY-MM-DD',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
};

const TOOLS: ToolDef[] = [
  {
    schema: {
      name: 'get_trial_balance',
      description:
        'Trial balance as of a given date. Returns one row per account with debit / credit / balance plus the standard normal-balance sign convention.',
      input_schema: {
        type: 'object',
        properties: { asOf: dateField },
        required: ['asOf'],
      },
    },
    run: async (tx, input) => {
      const asOf = String(input.asOf);
      return await trialBalance(tx, asOf);
    },
  },
  {
    schema: {
      name: 'get_profit_and_loss',
      description:
        'P&L for a date range. Sections: revenue + expenses, plus totals + net income. Use start/end inclusive.',
      input_schema: {
        type: 'object',
        properties: {
          start: dateField,
          end: dateField,
          basis: { type: 'string', enum: ['accrual'], description: 'accrual only in v1' },
        },
        required: ['start', 'end'],
      },
    },
    run: async (tx, input) =>
      profitAndLoss(tx, String(input.start), String(input.end), 'accrual'),
  },
  {
    schema: {
      name: 'get_balance_sheet',
      description:
        'Balance sheet as of a date: assets / liabilities / equity sections with totals + an imbalance check.',
      input_schema: {
        type: 'object',
        properties: { asOf: dateField },
        required: ['asOf'],
      },
    },
    run: async (tx, input) => balanceSheet(tx, String(input.asOf)),
  },
  {
    schema: {
      name: 'get_ar_aging',
      description:
        'Accounts-receivable aging by customer as of a date. Buckets: current, 1-30, 31-60, 61-90, over 90 days past due.',
      input_schema: {
        type: 'object',
        properties: { asOf: dateField },
        required: ['asOf'],
      },
    },
    run: async (tx, input) => arAging(tx, String(input.asOf)),
  },
  {
    schema: {
      name: 'get_ap_aging',
      description:
        'Accounts-payable aging by vendor as of a date. Same bucket structure as A/R aging.',
      input_schema: {
        type: 'object',
        properties: { asOf: dateField },
        required: ['asOf'],
      },
    },
    run: async (tx, input) => apAging(tx, String(input.asOf)),
  },
  {
    schema: {
      name: 'list_customers',
      description: 'List customers in this company. Returns id, name, email, phone, default terms, opening balance, isActive.',
      input_schema: {
        type: 'object',
        properties: {
          active: { type: 'boolean', description: 'Only active customers when true' },
        },
      },
    },
    run: async (tx, input) => {
      const rows = await tx
        .select()
        .from(customers)
        .where(input.active === true ? eq(customers.isActive, true) : undefined)
        .orderBy(customers.displayName);
      return rows;
    },
  },
  {
    schema: {
      name: 'list_vendors',
      description:
        'List vendors. Filter to 1099-flagged vendors with is1099=true (useful for year-end 1099 prep).',
      input_schema: {
        type: 'object',
        properties: {
          active: { type: 'boolean' },
          is1099: { type: 'boolean' },
        },
      },
    },
    run: async (tx, input) => {
      const rows = await tx
        .select()
        .from(vendors)
        .where(
          and(
            input.active === true ? eq(vendors.isActive, true) : undefined,
            input.is1099 === true ? eq(vendors.is1099Vendor, true) : undefined,
          ),
        )
        .orderBy(vendors.displayName);
      return rows;
    },
  },
  {
    schema: {
      name: 'list_invoices',
      description:
        'List invoices. Filter by status (open/partial/paid/void) or by date range or by customerId.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'partial', 'paid', 'void'] },
          customerId: { type: 'string', format: 'uuid' },
          since: dateField,
          until: dateField,
        },
      },
    },
    run: async (tx, input) => {
      const rows = await tx
        .select()
        .from(invoices)
        .where(
          and(
            input.status ? eq(invoices.status, input.status as never) : undefined,
            input.customerId ? eq(invoices.customerId, String(input.customerId)) : undefined,
            input.since ? gte(invoices.invoiceDate, String(input.since)) : undefined,
            input.until ? lte(invoices.invoiceDate, String(input.until)) : undefined,
          ),
        )
        .orderBy(desc(invoices.invoiceDate));
      return rows;
    },
  },
  {
    schema: {
      name: 'list_bills',
      description:
        'List bills. Filter by status, vendorId, or date range.',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'partial', 'paid', 'void'] },
          vendorId: { type: 'string', format: 'uuid' },
          since: dateField,
          until: dateField,
        },
      },
    },
    run: async (tx, input) => {
      const rows = await tx
        .select()
        .from(bills)
        .where(
          and(
            input.status ? eq(bills.status, input.status as never) : undefined,
            input.vendorId ? eq(bills.vendorId, String(input.vendorId)) : undefined,
            input.since ? gte(bills.billDate, String(input.since)) : undefined,
            input.until ? lte(bills.billDate, String(input.until)) : undefined,
          ),
        )
        .orderBy(desc(bills.billDate));
      return rows;
    },
  },
  {
    schema: {
      name: 'list_payments',
      description:
        'List payments. type=customer_received or vendor_sent. Optional date range.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['customer_received', 'vendor_sent'] },
          since: dateField,
          until: dateField,
        },
      },
    },
    run: async (tx, input) => {
      const rows = await tx
        .select()
        .from(payments)
        .where(
          and(
            input.type ? eq(payments.paymentType, input.type as never) : undefined,
            input.since ? gte(payments.paymentDate, String(input.since)) : undefined,
            input.until ? lte(payments.paymentDate, String(input.until)) : undefined,
          ),
        )
        .orderBy(desc(payments.paymentDate));
      return rows;
    },
  },
  {
    schema: {
      name: 'list_accounts',
      description:
        'List chart-of-accounts rows. Optionally filter to a specific account type.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['asset', 'liability', 'equity', 'revenue', 'expense'] },
          active: { type: 'boolean' },
        },
      },
    },
    run: async (tx, input) => {
      const rows = await tx
        .select()
        .from(accounts)
        .where(
          and(
            input.type ? eq(accounts.type, input.type as never) : undefined,
            input.active === true ? eq(accounts.isActive, true) : undefined,
          ),
        )
        .orderBy(accounts.code);
      return rows;
    },
  },
];

// ---------------------------- Driver -------------------------------------

/**
 * Build the system prompt. We inject today's date so Claude can reason about
 * relative phrases ("this month", "last quarter") without needing a tool
 * round-trip. We DO NOT inject the company name -- the tool results will
 * carry whatever company-scoped data is appropriate.
 */
function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are KPBooks's AI bookkeeping assistant. You help a CPA's bookkeepers answer questions about their client's books quickly and accurately.

Today's date is ${today}. Use it to interpret relative time phrases like "this month", "last quarter", "year-to-date".

Rules:
- Use the provided tools to look up real data. Never make up numbers, customer/vendor names, or invoice / bill numbers.
- Format USD amounts with commas + 2 decimals: $1,234.56.
- When the user's question is ambiguous about the date range, default to month-to-date and say so.
- Cash basis isn't supported in v1; use accrual.
- Be concise. Lead with the answer; then provide enough detail to be useful but don't dump tool output verbatim.
- If a tool returns an empty result, say so plainly -- don't speculate.
- If the user asks something the tools can't answer (e.g. "post a journal entry"), explain politely that you're read-only and point them at the right tab.`;
}

interface AnthropicContentBlock {
  type: string;
  // text block:
  text?: string;
  // tool_use block:
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicMessageResp {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
}

export async function chat(
  tx: Database,
  ctx: ChatContext,
  req: ChatRequest,
): Promise<ChatResponse> {
  if (!anthropicAvailable()) {
    throw new ChatError('ANTHROPIC_API_KEY not configured', 'ai_unavailable');
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new ChatError('messages must be a non-empty array', 'invalid_input');
  }
  const lastUser = req.messages[req.messages.length - 1];
  if (!lastUser || lastUser.role !== 'user') {
    throw new ChatError('the final message must be a user message', 'invalid_input');
  }

  const toolByName = new Map<string, ToolDef>(TOOLS.map((t) => [t.schema.name, t]));
  const toolCallsLog: ChatToolCall[] = [];

  // We mutate this messages array as we go through tool-use iterations.
  // Initially it's just the user-supplied conversation, but assistant
  // tool_use turns + user tool_result turns get appended on each loop.
  type ApiMessage = {
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  };
  const apiMessages: ApiMessage[] = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let stopReason: string | undefined;
  let finalText = '';
  let iterationLimitReached = false;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let resp: AnthropicMessageResp;
    try {
      // We need raw access to the Messages API to pass `tools` -- the
      // callAnthropic wrapper doesn't surface that yet. Use fetch directly.
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: req.model ?? DEFAULT_MODEL,
          max_tokens: 2048,
          system: systemPrompt(),
          tools: TOOLS.map((t) => t.schema),
          messages: apiMessages,
        }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new AnthropicError(`Anthropic ${r.status}: ${detail.slice(0, 500)}`, r.status);
      }
      resp = (await r.json()) as AnthropicMessageResp;
    } catch (err) {
      throw new ChatError(
        err instanceof Error ? err.message : String(err),
        'ai_failed',
      );
    }

    stopReason = resp.stop_reason;
    const content = resp.content ?? [];
    // Append the assistant's turn to the conversation as-is so subsequent
    // tool_result turns can reference its tool_use ids.
    apiMessages.push({
      role: 'assistant',
      content: content as unknown as Array<Record<string, unknown>>,
    });

    // Pull text out for the final reply (last text block wins).
    for (const block of content) {
      if (block.type === 'text' && block.text) finalText = block.text;
    }

    if (stopReason !== 'tool_use') {
      // end_turn / max_tokens / etc. -- we're done.
      break;
    }

    // Execute every tool_use block in this assistant turn, append
    // tool_result blocks as a single user turn.
    const toolResultBlocks: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (block.type !== 'tool_use' || !block.name || !block.id) continue;
      const def = toolByName.get(block.name);
      let toolJson: string;
      let isError = false;
      if (!def) {
        toolJson = JSON.stringify({ error: `unknown tool: ${block.name}` });
        isError = true;
      } else {
        try {
          const result = await def.run(tx, block.input ?? {});
          toolJson = JSON.stringify(result);
        } catch (err) {
          toolJson = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
          isError = true;
        }
      }
      toolCallsLog.push({
        name: block.name,
        input: block.input ?? {},
        // Truncate at 4 KB for the UI breadcrumb -- the tool input/output is
        // often verbose JSON the user doesn't want to scroll past. The full
        // payload still goes back to Claude on the next loop.
        result: toolJson.length > 4096 ? toolJson.slice(0, 4096) + '…[truncated]' : toolJson,
      });
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: toolJson,
        ...(isError ? { is_error: true } : {}),
      });
    }
    if (toolResultBlocks.length === 0) {
      // Defensive: claude said tool_use but emitted no tool_use blocks?
      break;
    }
    apiMessages.push({ role: 'user', content: toolResultBlocks });

    if (i === MAX_TOOL_ITERATIONS - 1) iterationLimitReached = true;
  }

  void ctx; // ctx isn't directly read here; RLS is set on the tx by the caller.

  return {
    reply: finalText || "(no reply)",
    toolCalls: toolCallsLog,
    stopReason,
    iterationLimitReached,
  };
}
