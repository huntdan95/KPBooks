import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isAvailable as anthropicAvailable } from '../modules/ai/anthropic.js';
import { ChatError, chat } from '../modules/ai/chat.js';

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
};
