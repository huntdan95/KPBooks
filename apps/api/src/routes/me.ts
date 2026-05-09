import { companies, memberships } from '@kpbooks/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

/**
 * GET /v1/me — returns the authenticated user and the companies they belong to.
 *
 * Used by the web app on first load to populate the company switcher and to
 * decide whether to show the "create your first company" empty state.
 *
 * No company context required (no x-kpbooks-company header). RLS on
 * `memberships` is intentionally off so this query works for the user's full
 * roster of clients in one round-trip.
 */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (req) => {
    const auth = await app.requireAuth(req);

    // Deterministic order: oldest membership first. Matters because the web
    // bootstraps the active company picker from memberships[0] when nothing
    // is stored locally; without an order-by Postgres would return whatever
    // scan order it likes, which can change run-to-run.
    const rows = await app.db
      .select({
        companyId: memberships.companyId,
        companyName: companies.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(eq(memberships.userId, auth.userId))
      .orderBy(asc(memberships.createdAt), asc(companies.name));

    return {
      user: {
        id: auth.userId,
        email: auth.email,
        firebaseUid: auth.firebaseUid,
      },
      memberships: rows,
    };
  });
};
