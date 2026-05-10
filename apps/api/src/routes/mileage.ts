import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CreateTripSchema,
  MileageError,
  PostMileageSchema,
  UpdateTripSchema,
  createTrip,
  deleteTrip,
  listTrips,
  postMileage,
  updateTrip,
} from '../modules/mileage/mileage.service.js';

const errStatus = (code: MileageError['code']): number => {
  switch (code) {
    case 'not_found':
      return 404;
    case 'wrong_status':
    case 'no_trips':
      return 409;
    case 'posting_failed':
      return 502;
    default:
      return 422;
  }
};

export const mileageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req) => {
    await app.requireAuth(req);
  });

  app.get('/mileage-trips', async (req) =>
    req.withTenantTx(async (tx) => ({ trips: await listTrips(tx) })),
  );

  app.post('/mileage-trips', async (req, reply) => {
    const body = CreateTripSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        createTrip(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof MileageError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.patch('/mileage-trips/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateTripSchema.parse(req.body);
    try {
      await req.withTenantTx(async (tx) => updateTrip(tx, id, body));
      return reply.send({ id });
    } catch (err) {
      if (err instanceof MileageError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.delete('/mileage-trips/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      await req.withTenantTx(async (tx) => deleteTrip(tx, id));
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof MileageError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/mileage-trips/post', async (req, reply) => {
    const body = PostMileageSchema.parse(req.body);
    try {
      const result = await req.withTenantTx(async (tx) =>
        postMileage(
          tx,
          { companyId: req.auth!.companyId!, userId: req.auth!.userId },
          body,
        ),
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof MileageError) {
        return reply.status(errStatus(err.code)).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
};
