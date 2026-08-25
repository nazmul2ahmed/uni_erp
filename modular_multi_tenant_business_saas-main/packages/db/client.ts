/**
 * Database client + tenant-scoped transaction helper.
 *
 * Implements RULE-POOL-001/002 (05 §25, Decision TEN-002):
 *   `SET LOCAL app.tenant_id` MUST be the first statement inside
 *   every tenant-scoped transaction, on the SAME transaction as
 *   every subsequent tenant-scoped query. This makes the pattern
 *   safe under PgBouncer transaction-mode pooling.
 *
 * NEVER use `SET SESSION` — it survives connection-pool handback
 * and can leak tenant context across tenants (05 §160-161).
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as controlSchema from "./schema/control";
import * as coreSchema from "./schema/core";

const schema = { ...controlSchema, ...coreSchema };

const connectionString =
  process.env.DATABASE_URL ?? "postgres://erp:erp_dev_password@localhost:5432/erp_dev";

// Single pooled connection group for Shared mode (04 §29, Phase 1 default).
// Dedicated-tenant routing (05 §27-30) is out of scope until Phase 7.
const queryClient = postgres(connectionString, { max: 10 });

export const db = drizzle(queryClient, { schema });

export type Database = typeof db;

/**
 * withTenantTransaction — the ONLY sanctioned way to run a tenant-scoped
 * mutation or query. Wraps `callback` in a Postgres transaction whose
 * FIRST statement sets `app.tenant_id` for RLS policies to consume.
 *
 * Per 05 §25 (Decision TEN-002) and 04 §143's withTransaction() abstraction.
 */
export async function withTenantTransaction<T>(
  tenantId: string,
  callback: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Parameterized to prevent injection even though tenantId is a
    // server-resolved UUID, never client-supplied raw text (05 §17,20).
    await tx.execute(sql_setLocal(tenantId));
    return callback(tx as unknown as Database);
  });
}

// Small helper kept separate so the SET LOCAL statement is visually
// distinct/greppable in code review (13 §9.2 checklist item: "no raw
// SQL string concatenation of user input" — tenantId here is a
// validated UUID from TenantContext, not raw user input).
import { sql } from "drizzle-orm";
function sql_setLocal(tenantId: string) {
  return sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

/**
 * withPlatformTransaction — for Control-Plane-only operations that
 * have NO tenant scope (e.g. user registration before any tenant
 * exists). Never used for core.* tenant-owned tables.
 */
export async function withPlatformTransaction<T>(
  callback: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => callback(tx as unknown as Database));
}

export { schema };
export * from "./schema/control";
export * from "./schema/core";
