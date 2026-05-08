import { accounts, companies, memberships, type Database } from '@kpbooks/db';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DEFAULT_COA } from './coa-defaults.js';

/**
 * Create a new company, attach the caller as `owner`, and seed the default COA.
 *
 * Why a single transaction:
 * - We pre-generate the company UUID so we can SET LOCAL app.current_company to
 *   it BEFORE the INSERT. That makes the RLS WITH CHECK clause pass without
 *   needing a "platform admin" bypass policy.
 * - All four operations (company, membership, COA, identity GUC) commit
 *   atomically — no partially-created tenants if something fails midway.
 */
export interface CreateCompanyInput {
  name: string;
  legalName?: string | null | undefined;
  ein?: string | null | undefined;
}

export interface CreateCompanyResult {
  id: string;
  name: string;
  accountsCreated: number;
}

export async function createCompanyForUser(
  db: Database,
  userId: string,
  input: CreateCompanyInput,
): Promise<CreateCompanyResult> {
  const companyId = randomUUID();

  return db.transaction(async (tx) => {
    // Set the tenant GUCs to the about-to-be-created company so RLS allows the inserts.
    await tx.execute(sql`SELECT set_config('app.current_company', ${companyId}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_user', ${userId}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_role', 'owner', true)`);

    await tx.insert(companies).values({
      id: companyId,
      name: input.name,
      legalName: input.legalName ?? null,
      ein: input.ein ?? null,
    });

    // memberships isn't RLS-protected (auth plugin reads it before GUCs are set),
    // so this insert works regardless of tenant context.
    await tx.insert(memberships).values({
      userId,
      companyId,
      role: 'owner',
    });

    // Seed default chart of accounts.
    await tx.insert(accounts).values(
      DEFAULT_COA.map((a) => ({
        companyId,
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
      })),
    );

    return {
      id: companyId,
      name: input.name,
      accountsCreated: DEFAULT_COA.length,
    };
  });
}
