/**
 * Database client + tenant-scoped transaction helper.
 *
 * Implements RULE-POOL-001/002 (05 §25, Decision TEN-002):
 *   Setting `app.tenant_id` (via `set_config('app.tenant_id', ..., true)`
 *   — the `true` third argument is `is_local`, i.e. LOCAL-transaction
 *   scope, equivalent to `SET LOCAL`) MUST be the first statement
 *   inside every tenant-scoped transaction, on the SAME transaction
 *   as every subsequent tenant-scoped query. This makes the pattern
 *   safe under PgBouncer transaction-mode pooling.
 *
 * NEVER use `SET SESSION` / `set_config(..., false)` — it survives
 * connection-pool handback and can leak tenant context across
 * tenants (05 §160-161).
 *
 * NOTE: `set_config()` (a function call), not the bare `SET LOCAL ...`
 * statement, is used below — PostgreSQL's `SET`/`SET LOCAL` commands
 * do not accept bind parameters for their value, only `set_config()`
 * does (see `sql_setLocal`'s docblock for the concrete defect this
 * form was introduced to fix).
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as controlSchema from "./schema/control";
import * as coreSchema from "./schema/core";
import * as commerceSchema from "./schema/commerce";

const schema = { ...controlSchema, ...coreSchema, ...commerceSchema };

// Runtime application connections use the non-superuser, non-owner
// erp_app role (RLS Role Architecture Decision) — NOT the migration/
// owner `erp` connection (DATABASE_URL, still used only by
// drizzle.config.ts / migrate.ts). Using `erp` here would make every
// RLS policy a silent no-op, since a superuser/table-owner role
// bypasses RLS unconditionally regardless of policy correctness.
const connectionString =
  process.env.DATABASE_URL_APP ?? "postgres://erp_app:erp_app_dev_password@localhost:5432/erp_dev";

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

// Small helper kept separate so the tenant-scoping statement is
// visually distinct/greppable in code review (13 §9.2 checklist item:
// "no raw SQL string concatenation of user input" — tenantId here is a
// validated UUID from TenantContext, not raw user input).
//
// BUGFIX (Phase 2 discovery, tenant-isolation integration test suite):
// `SET LOCAL app.tenant_id = ${tenantId}` — using the bare `SET`
// statement with an interpolated value — is INVALID PostgreSQL syntax
// once drizzle's `sql` tag (correctly, per parameterized-query
// discipline, 13 §4.2) binds `${tenantId}` as a `$1` placeholder
// rather than inlining it as a literal. PostgreSQL's `SET`/`SET LOCAL`
// commands do not accept bind parameters for their value — only a
// literal or a function call does. This was UNDETECTED until now
// because every prior manual/build verification (typecheck, lint,
// `next build`) only proves the TypeScript/SQL-template compiles; it
// never executes against a live database. The one existing test that
// DOES hit a live database (packages/db/test/rls.test.ts) happened to
// already use the correct form (`SELECT set_config('app.tenant_id',
// $1, true)`, a plain function call, which DOES accept bind
// parameters) — so this defect was invisible until a second, actually
// end-to-end test path (apps/web/test/tenant-isolation.integration.test.ts)
// exercised `withTenantTransaction` itself for the first time. Fixed
// here to the same `set_config()` form rls.test.ts already used
// correctly — this changes ONLY the SQL dialect used to set the
// session variable; the transaction-scoping discipline (05 §25,
// Decision TEN-002) itself is unchanged.
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
export * from "./schema/commerce";