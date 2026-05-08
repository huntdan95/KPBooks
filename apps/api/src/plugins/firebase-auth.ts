import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  type App,
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from 'firebase-admin/app';
import { type DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { memberships, users } from '@kpbooks/db';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest) => Promise<AuthContext>;
  }
}

export interface AuthContext {
  firebaseUid: string;
  userId: string;
  email: string;
  /** Active company (from x-kpbooks-company header). Null if user hasn't picked one. */
  companyId: string | null;
  role: 'owner' | 'admin' | 'bookkeeper' | 'viewer' | null;
  token: DecodedIdToken;
}

interface FirebaseAuthOptions {
  projectId: string;
  credentialsPath?: string | undefined;
}

const plugin: FastifyPluginAsync<FirebaseAuthOptions> = async (app, opts) => {
  const firebaseApp = initFirebaseAdmin(opts);
  const auth = getAuth(firebaseApp);

  app.decorate('requireAuth', async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
    if (req.auth) return req.auth;

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw app.httpErrors.unauthorized('missing bearer token');
    }
    const idToken = header.slice('Bearer '.length).trim();

    let decoded: DecodedIdToken;
    try {
      // Cryptographic-only verification (signature + standard claims). Cheap
      // and stateless. We deliberately don't pass checkRevoked: true here —
      // that path calls the Firebase Auth admin getUser API and would need
      // roles/firebaseauth.viewer on the Cloud Run service account just to
      // boot. If we ever need revocation we'll add it as an opt-in for
      // sensitive endpoints, not the default path.
      decoded = await auth.verifyIdToken(idToken);
    } catch (err) {
      req.log.warn({ err }, 'invalid id token');
      throw app.httpErrors.unauthorized('invalid id token');
    }

    // Resolve / create the local user row mirroring the Firebase identity.
    const user = await app.db
      .select()
      .from(users)
      .where(eq(users.firebaseUid, decoded.uid))
      .limit(1);

    let userId: string;
    let email: string;
    if (user.length === 0) {
      if (!decoded.email) {
        throw app.httpErrors.forbidden('firebase user has no email');
      }
      const inserted = await app.db
        .insert(users)
        .values({
          firebaseUid: decoded.uid,
          email: decoded.email,
          displayName: decoded.name ?? null,
        })
        .returning({ id: users.id, email: users.email });
      userId = inserted[0]!.id;
      email = inserted[0]!.email;
    } else {
      userId = user[0]!.id;
      email = user[0]!.email;
    }

    // Resolve current company from header (set by the web app after company switcher).
    const requestedCompany = req.headers['x-kpbooks-company'];
    const companyId = typeof requestedCompany === 'string' ? requestedCompany : null;

    let role: AuthContext['role'] = null;
    if (companyId) {
      const m = await app.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.companyId, companyId)))
        .limit(1);
      if (m.length === 0) {
        throw app.httpErrors.forbidden('not a member of this company');
      }
      role = m[0]!.role;
    }

    const ctx: AuthContext = {
      firebaseUid: decoded.uid,
      userId,
      email,
      companyId,
      role,
      token: decoded,
    };
    req.auth = ctx;
    return ctx;
  });
};

export const firebaseAuthPlugin = fp(plugin, { name: 'firebase-auth' });

function initFirebaseAdmin(opts: FirebaseAuthOptions): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const credential = opts.credentialsPath ? cert(opts.credentialsPath) : applicationDefault();
  return initializeApp({
    projectId: opts.projectId,
    credential,
  });
}
