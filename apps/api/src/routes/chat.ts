import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isAvailable as anthropicAvailable } from '../modules/ai/anthropic.js';
import { ChatError, chat } from '../modules/ai/chat.js';
import { ReceiptOcrError, extractReceipt } from '../modules/ai/receipt-ocr.js';

const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(20_000),
      }),
    )
    .min(1)
    .max(40, 'conversation too long; trim earlier turns'),
  model: z.string().max(80).optional(),
});

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/chat/status', async () => ({ available: anthropicAvailable() }));

  app.post('/chat', async (req, reply) => {
    const body = ChatBody.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        chat(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof ChatError) {
        const status =
          err.code === 'ai_unavailable' ? 503 : err.code === 'ai_failed' ? 502 : 422;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // Receipt OCR -- doesn't need DB access; just calls Anthropic with the
  // provided image and returns the extracted shape for the UI to use as a
  // prefill for the New Bill form.
  const ExtractReceiptBody = z.object({
    imageBase64: z
      .string()
      .min(100, 'imageBase64 looks empty')
      .max(8_000_000, 'image too large; resize below ~5 MB'),
    mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  });

  app.post('/ai/extract-receipt', async (req, reply) => {
    const body = ExtractReceiptBody.parse(req.body);
    try {
      const result = await extractReceipt(body);
      return reply.send(result);
    } catch (err) {
      if (err instanceof ReceiptOcrError) {
        const status =
          err.code === 'ai_unavailable'
            ? 503
            : err.code === 'invalid_input'
              ? 422
              : err.code === 'parse_failed'
                ? 502
                : 502;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
