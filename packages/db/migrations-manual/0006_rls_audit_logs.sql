-- Row Level Security policy for core.audit_logs.
--
-- Per 05_MULTI_TENANT_ARCHITECTURE.md §24-26 and
-- 06_DATABASE_SPECIFICATION.md v2.0 §5.15 / 07 §15.
--
-- Background (Finding B, code-review reconciliation pass): the tenant-
-- scoped business audit table (distinct from control.audit_events_platform,
-- which already existed and is platform-scoped) was missing from the
-- schema entirely -- no mutating Use Case had anywhere to write an audit
-- row. Added via migrations/0004_green_mariko_yashida.sql (drizzle-kit
-- generate); this file adds the RLS policy the same way every other
-- core.* table's policy was added manually in 0001/0004/0005.
--
-- IDEMPOTENCY: DROP POLICY IF EXISTS + CREATE POLICY, matching the exact
-- pattern established in 0001/0004/0005.
--
-- GRANTS: no new grant migration required -- 0003_grant_app_role.sql's
-- ALTER DEFAULT PRIVILEGES already covers any future table created by
-- the `erp` owner role in the `core` schema.
--
-- Defense-in-depth: RLS is one layer among several (05 §26) --
-- application-layer tenant scoping (withTenantTransaction) is REQUIRED
-- regardless, and lib/audit.ts's recordAudit() is written to always run
-- inside the caller's already-tenant-scoped transaction, never a bare
-- top-level `db.insert`.

ALTER TABLE core.audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_audit_logs ON core.audit_logs;
CREATE POLICY tenant_isolation_audit_logs ON core.audit_logs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Audit rows are append-only (07 §15.1 -- no UpdateAuditLog use case
-- exists by design). Enforce at the database level too: revoke UPDATE/
-- DELETE from the application runtime role, mirroring the immutability
-- guarantee already given to core.stock_movements and core.journals by
-- convention (no UPDATE/DELETE code path), now made a hard DB constraint
-- for this specific table since audit integrity is the one domain where
-- "no code path happens to touch it" is not a strong enough guarantee.
REVOKE UPDATE, DELETE ON core.audit_logs FROM erp_app;
