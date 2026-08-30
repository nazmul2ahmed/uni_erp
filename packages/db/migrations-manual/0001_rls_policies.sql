-- Row Level Security policies for Shared-mode tenant isolation.
-- Per 05_MULTI_TENANT_ARCHITECTURE.md §24-26 (Decision TEN-002 for
-- the SET LOCAL discipline this policy depends on).
--
-- Applied manually (not via drizzle-kit, which does not model RLS)
-- after the base schema migration. Run via `pnpm db:migrate`.
--
-- Defense-in-depth: RLS is ONE layer among several (05 §26) —
-- application-layer tenant scoping (packages/db/client.ts,
-- withTenantTransaction) is REQUIRED regardless of RLS being present.
--
-- IDEMPOTENCY NOTE: `ENABLE ROW LEVEL SECURITY` is naturally idempotent
-- (safe to re-run). `CREATE POLICY` is NOT — PostgreSQL has no
-- `CREATE POLICY IF NOT EXISTS` syntax, so every policy below is
-- preceded by `DROP POLICY IF EXISTS` to make this migration safely
-- re-runnable, per 25_DEPLOYMENT_ARCHITECTURE.md §8's requirement that
-- every migration step be backward-compatible / re-runnable within a
-- rolling deploy's overlap window.

ALTER TABLE core.business_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_business_profiles ON core.business_profiles;

CREATE POLICY tenant_isolation_business_profiles ON core.business_profiles
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Fail-closed default: if app.tenant_id is never set (e.g. a stray
-- platform-level query against a tenant-owned table), current_setting
-- with `true` (missing_ok) returns NULL, and NULL = anything is NULL
-- (never TRUE) in Postgres — so the policy denies by default rather
-- than accidentally allowing, per 05 §159 Fail Closed Principle.

-- Future tenant-owned tables (Phase 2+: core.customers, core.sales, ...)
-- MUST add an equivalent block here as part of their own migration,
-- per the New Table Checklist (05 §126), following this EXACT pattern:
--
--   ALTER TABLE core.<table> ENABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS tenant_isolation_<table> ON core.<table>;
--   CREATE POLICY tenant_isolation_<table> ON core.<table>
--     USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
--
-- Never a bare CREATE POLICY without the preceding DROP POLICY IF
-- EXISTS guard — this migration's original failure (PG 42710,
-- "policy already exists" on a second run) is the concrete regression
-- this pattern prevents.