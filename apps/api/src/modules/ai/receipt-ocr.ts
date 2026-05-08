/**
 * Receipt OCR via Claude vision. The user drops a receipt image; we send it
 * to Claude with a structured-output prompt and get back vendor / total /
 * date / line-item extraction. The frontend uses that to prefill a New Bill
 * form -- the bookkeeper reviews, picks an expense account, and posts.
 *
 * Vision-capable models tokens: each image consumes ~1.5K-2K input tokens
 * depending on resolution. Default to Haiku 4.5 (fast + cheap; good vision
 * quality for receipts).
 */
import { stripCodeFence } from './anthropic.js';

const VISION_MODEL = 'claude-haiku-4-5-20251001';
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const SUPPORTED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export interface ExtractedReceiptLine {
  description: string;
  amount: string; // 4dp decimal string
}

export interface ExtractedReceipt {
  vendor: string | null;
  total: string | null;
  /** YYYY-MM-DD or null. */
  date: string | null;
  lineItems: ExtractedReceiptLine[];
  /** True when the model believes the image isn't a receipt at all. */
  notAReceipt: boolean;
  /** Free-text caveat from the model (low quality image, partial text, etc.). */
  notes: string | null;
}

export class ReceiptOcrError extends Error {
  constructor(
    message: string,
    public readonly code: 'ai_unavailable' | 'ai_failed' | 'invalid_input' | 'parse_failed',
  ) {
    super(message);
    this.name = 'ReceiptOcrError';
  }
}

const SYSTEM_PROMPT = `You are an accounts-payable assistant. Extract structured data from receipt images for a CPA's bookkeeper.

Return ONLY a JSON object with this exact shape (no surrounding prose, no code fence):
{
  "vendor": string or null,
  "total": string or null (in dollars, e.g. "47.85"; the grand total INCLUDING tax),
  "date": string or null (YYYY-MM-DD; convert from MM/DD/YYYY etc.),
  "lineItems": [{ "description": string, "amount": string }],
  "notAReceipt": boolean,
  "notes": string or null
}

Rules:
- If the image isn't a receipt or invoice (random photo, blank screen, etc.), set notAReceipt=true and the other fields to null/empty.
- vendor: the merchant or supplier name, not the user's name.
- total: the FINAL total paid, including tax, as a plain decimal string. No currency symbol. No commas. Use "47.85" not "$47.85".
- date: prefer the transaction date over print date. If only month/day visible and current year is unambiguous, use it; otherwise null.
- lineItems: only include if individual items are clearly labelled with prices. Otherwise return an empty array (the user can edit). Don't fabricate -- a single "Total" line is not an item.
- notes: 1 short sentence ONLY when something is uncertain (low quality, partial text, multiple totals, etc.). Otherwise null.`;

export function isAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function extractReceipt(opts: {
  imageBase64: string;
  mediaType: string;
}): Promise<ExtractedReceipt> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ReceiptOcrError('ANTHROPIC_API_KEY not configured', 'ai_unavailable');
  }
  if (!SUPPORTED_MEDIA_TYPES.has(opts.mediaType)) {
    throw new ReceiptOcrError(
      `unsupported media type "${opts.mediaType}"; use jpeg / png / gif / webp`,
      'invalid_input',
    );
  }
  // Quick sanity on payload size: base64 inflates ~33%; an 8-MB Fastify
  // bodyLimit covers ~6 MB binary, but we want to surface a friendly error
  // before Anthropic does for huge captures.
  if (opts.imageBase64.length > 7_000_000) {
    throw new ReceiptOcrError(
      `image too large (${(opts.imageBase64.length / 1e6).toFixed(1)} MB base64); resize below ~5 MB`,
      'invalid_input',
    );
  }

  let resp: Response;
  try {
    resp = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 1024,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: opts.mediaType,
                  data: opts.imageBase64,
                },
              },
              {
                type: 'text',
                text: 'Extract the receipt data per the system rules.',
              },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    throw new ReceiptOcrError(
      err instanceof Error ? err.message : String(err),
      'ai_failed',
    );
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new ReceiptOcrError(
      `Anthropic ${resp.status}: ${detail.slice(0, 500)}`,
      'ai_failed',
    );
  }

  const json = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const textBlock = (json.content ?? []).find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new ReceiptOcrError('Anthropic returned no text content', 'ai_failed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(textBlock.text));
  } catch (err) {
    throw new ReceiptOcrError(
      `model output wasn't valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      'parse_failed',
    );
  }

  return normaliseExtraction(parsed);
}

function normaliseExtraction(v: unknown): ExtractedReceipt {
  const obj = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const vendor = typeof obj.vendor === 'string' && obj.vendor.trim() ? obj.vendor.trim() : null;
  const total = normaliseAmount(obj.total);
  const date = normaliseDate(obj.date);
  const notAReceipt = obj.notAReceipt === true;
  const notes = typeof obj.notes === 'string' && obj.notes.trim() ? obj.notes.trim() : null;
  const items = Array.isArray(obj.lineItems) ? obj.lineItems : [];
  const lineItems: ExtractedReceiptLine[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const rec = it as Record<string, unknown>;
    const description =
      typeof rec.description === 'string' && rec.description.trim()
        ? rec.description.trim().slice(0, 500)
        : null;
    const amount = normaliseAmount(rec.amount);
    if (description && amount) {
      lineItems.push({ description, amount });
    }
  }
  return { vendor, total, date, lineItems, notAReceipt, notes };
}

function normaliseAmount(v: unknown): string | null {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  // Strip $, commas, spaces. Accept (12.34) as -12.34 -- shouldn't appear
  // on a receipt but handle defensively.
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  const padded = (frac + '0000').slice(0, 4);
  return `${neg ? '-' : ''}${whole}.${padded}`;
}

function normaliseDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/);
  if (!m) return null;
  const month = parseInt(m[1]!, 10);
  const day = parseInt(m[2]!, 10);
  let year = parseInt(m[3]!, 10);
  if (m[3]!.length === 2) year = year < 50 ? 2000 + year : 1900 + year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
