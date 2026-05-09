import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  AddLineSchema,
  CreatePayrollRunSchema,
  PayrollRunError,
  UpdateLineSchema,
  UpdatePayrollRunSchema,
  addLine,
  createPayrollRun,
  deletePayrollRun,
  getRun,
  listEligibleWorkers,
  listRuns,
  postPayrollRun,
  removeLine,
  updateLine,
  updatePayrollRun,
  voidPayrollRun,
} from '../modules/payroll-runs/payroll-runs.service.js';

const errStatus = (code: PayrollRunError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'wrong_status':
    case 'no_lines':
    case 'no_bank_account':
      return 409;
    case 'bill_failed':
    case 'payment_failed':
      return 502;
    default:
      return 422;
  }
};

export const payrollRunsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/payroll-runs', async (req) =>
    req.withTenantTx(async (tx) => ({ runs: await listRuns(tx) })),
  );

  app.get('/payroll-runs/eligible-workers', async (req) => {
    const q = z
      .object({
        workerType: z.enum(['contractor', 'employee', 'subcontractor']).optional(),
        paySchedule: z.enum(['weekly', 'biweekly', 'semimonthly', 'monthly']).optional(),
      })
      .parse(req.query);
    return req.withTenantTx(async (tx) => ({
      workers: await listEligibleWorkers(tx, q),
    }));
  });

  app.get('/payroll-runs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.withTenantTx(async (tx) => {
      const run = await getRun(tx, id);
      if (!run) return reply.status(404).send({ error: 'not_found' });
      return run;
    });
  });

  app.post('/payroll-runs', async (req, reply) => {
    const body = CreatePayrollRunSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createPayrollRun(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof PayrollRunError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.patch('/payroll-runs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdatePayrollRunSchema.parse(req.body);
    try {
      await req.withTenantTx(async (tx) => updatePayrollRun(tx, id, body));
      return reply.send({ id });
    } catch (err) {
      if (err instanceof PayrollRunError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.delete('/payroll-runs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      await req.withTenantTx(async (tx) => deletePayrollRun(tx, id));
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof PayrollRunError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/payroll-runs/:id/lines', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = AddLineSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        addLine(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof PayrollRunError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.patch('/payroll-runs/:id/lines/:lineId', async (req, reply) => {
    const { id, lineId } = z
      .object({ id: z.string().uuid(), lineId: z.string().uuid() })
      .parse(req.params);
    const body = UpdateLineSchema.parse(req.body);
    try {
      await req.withTenantTx(async (tx) => updateLine(tx, id, lineId, body));
      return reply.send({ id: lineId });
    } catch (err) {
      if (err instanceof PayrollRunError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.delete('/payroll-runs/:id/lines/:lineId', async (req, reply) => {
    const { id, lineId } = z
      .object({ id: z.string().uuid(), lineId: z.string().uuid() })
      .parse(req.params);
    try {
      await req.withTenantTx(async (tx) => removeLine(tx, id, lineId));
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof PayrollRunError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/payroll-runs/:id/post', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      const result = await req.withTenantTx(async (tx) =>
        postPayrollRun(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof PayrollRunError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/payroll-runs/:id/void', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      const result = await req.withTenantTx(async (tx) =>
        voidPayrollRun(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          id,
        ),
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof PayrollRunError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
