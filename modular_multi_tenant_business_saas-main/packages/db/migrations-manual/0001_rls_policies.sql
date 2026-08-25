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

ALTER TABLE core.business_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.business_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_business_profiles ON core.business_profiles
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Fail-closed default: if app.tenant_id is never set (e.g. a stray
-- platform-level query against a tenant-owned table), current_setting
-- with `true` (missing_ok) returns NULL, and NULL = anything is NULL
-- (never TRUE) in Postgres — so the policy denies by default rather
-- than accidentally allowing, per 05 §159 Fail Closed Principle.

-- Future tenant-owned tables (Phase 2+: core.customers, core.sales, ...)
-- MUST add an equivalent `ENABLE ROW LEVEL SECURITY` + policy pair here
-- as part of their own migration, per the New Table Checklist (05 §126).
