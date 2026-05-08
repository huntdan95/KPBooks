import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Config, corsOrigins } from './config.js';
import { dbPlugin } from './plugins/db.js';
import { firebaseAuthPlugin } from './plugins/firebase-auth.js';
import { rlsContextPlugin } from './plugins/rls.js';
import { companiesRoutes } from './routes/companies.js';
import { bankingRoutes } from './routes/banking.js';
import { billsRoutes } from './routes/bills.js';
import { chatRoutes } from './routes/chat.js';
import { customersRoutes } from './routes/customers.js';
import { estimatesRoutes } from './routes/estimates.js';
import { healthRoutes } from './routes/health.js';
import { importsRoutes } from './routes/imports.js';
import { invoicesRoutes } from './routes/invoices.js';
import { ledgerRoutes } from './routes/ledger.js';
import { meRoutes } from './routes/me.js';
import { paymentsRoutes } from './routes/payments.js';
import { taxRatesRoutes } from './routes/tax-rates.js';
import { vendorsRoutes } from './routes/vendors.js';
import { workersRoutes } from './routes/workers.js';

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } } }
        : {}),
    },
    trustProxy: true,
    // Default Fastify limit is 1 MiB; raise to 16 MiB to fit IIF imports
    // (hundreds of accounts/customers/vendors) and base64-encoded W-9 / W-4
    // / I-9 PDFs uploaded via /workers/:vendorId/documents (10 MiB raw -> ~14 MiB base64).
    bodyLimit: 16 * 1024 * 1024,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: corsOrigins(config),
    credentials: true,
  });

  // Order matters: db before auth before rls before routes.
  await app.register(dbPlugin, { url: config.DATABASE_URL });
  await app.register(firebaseAuthPlugin, {
    projectId: config.FIREBASE_PROJECT_ID,
    credentialsPath: config.GOOGLE_APPLICATION_CREDENTIALS,
  });
  await app.register(rlsContextPlugin);

  await app.register(healthRoutes, { prefix: '/v1' });
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(companiesRoutes, { prefix: '/v1' });
  await app.register(customersRoutes, { prefix: '/v1' });
  await app.register(vendorsRoutes, { prefix: '/v1' });
  await app.register(invoicesRoutes, { prefix: '/v1' });
  await app.register(estimatesRoutes, { prefix: '/v1' });
  await app.register(billsRoutes, { prefix: '/v1' });
  await app.register(paymentsRoutes, { prefix: '/v1' });
  await app.register(importsRoutes, { prefix: '/v1' });
  await app.register(bankingRoutes, { prefix: '/v1' });
  await app.register(taxRatesRoutes, { prefix: '/v1' });
  await app.register(workersRoutes, { prefix: '/v1' });
  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(ledgerRoutes, { prefix: '/v1' });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request failed');
    const e = err as Error & { validation?: unknown; statusCode?: number };
    if (e.validation) {
      return reply.status(400).send({ error: 'validation_failed', details: e.validation });
    }
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600) {
      return reply.status(e.statusCode).send({ error: e.name ?? 'error', message: e.message });
    }
    return reply.status(500).send({ error: 'internal_error' });
  });

  return app;
}
