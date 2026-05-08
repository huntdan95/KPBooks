import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  UploadViaTokenSchema,
  W9TokenError,
  lookupTokenForPublicView,
  uploadViaToken,
} from '../modules/w9-tokens/w9-tokens.service.js';

/**
 * Public (no-auth) routes for the contractor-facing W-9 upload workflow.
 *
 * No requireAuth hook -- these endpoints intentionally accept anonymous
 * traffic. Security comes from:
 *   - Token is 32 random bytes (256 bits, base64url'd to ~43 chars)
 *   - Single-use: once consumed the token is permanently retired
 *   - Time-limited: default 30 day TTL
 *   - SECURITY DEFINER lookup_w9_token bypasses RLS only enough to read
 *     the token's company_id; everything else flows through normal RLS
 *
 * Mounted at /v1/w9-upload/:token/* in app.ts.
 */

const errStatus = (code: W9TokenError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'expired':
    case 'already_used':
      return 410; // Gone -- accurately reflects an expired/consumed token
    case 'file_too_large':
      return 413;
    default:
      return 422;
  }
};

export const w9PublicRoutes: FastifyPluginAsync = async (app) => {
  // No requireAuth hook -- public on purpose.

  app.get('/w9-upload/:token/info', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(120) }).parse(req.params);
    const info = await lookupTokenForPublicView(app.db, token);
    if (!info.valid) {
      return reply.status(info.reason === 'not_found' ? 404 : 410).send({
        valid: false,
        reason: info.reason,
        ...(info.expiresAt ? { expiresAt: info.expiresAt } : {}),
      });
    }
    return info;
  });

  app.post('/w9-upload/:token/upload', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(120) }).parse(req.params);
    const body = UploadViaTokenSchema.parse(req.body);
    try {
      const result = await uploadViaToken(app.db, token, body);
      return reply.status(201).send({ ok: true, documentId: result.documentId });
    } catch (err) {
      if (err instanceof W9TokenError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
