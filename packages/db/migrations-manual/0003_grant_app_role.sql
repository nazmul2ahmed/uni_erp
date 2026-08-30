-- Privilege grants for the erp_app runtime role.
-- Per the RLS Role Architecture Decision (approved).
--
-- Companion to docker/init-roles.sql. Split into a separate file
-- specifically because GRANT / ALTER DEFAULT PRIVILEGES targeting a
-- schema require that schema to already exist — `control` and `core`
-- are not present at docker-entrypoint-initdb.d time, only after
-- `pnpm db:migrate` runs the drizzle-generated migration.
--
-- Applied manually (not via drizzle-kit), same pattern as
-- 0001_rls_policies.sql and 0002_owner_invariant.sql — run via
-- `pnpm db:migrate`, using the `erp` owner connection (unchanged,
-- per the RLS Role Architecture Decision item 7). Every statement
-- below is idempotent (GRANT / ALTER DEFAULT PRIVILEGES are safely
-- re-runnable).
--
-- Scope (deliberate, not expanded beyond the approved decision):
--   Only `control` and `core` are granted here. `modules`, `industry`,
--   `automation`, `billing`, `migration` schemas (per
--   06_DATABASE_SPECIFICATION.md v2.0 §3, §14-§16) are out of scope
--   for this file — they do not exist yet at Phase 1. A follow-up
--   migrations-manual file must extend this exact pattern to them
--   once those schemas are introduced.
--
-- Ownership model: `erp` owns and creates every table in
-- `control`/`core`. Default privileges below are declared FOR ROLE
-- erp so any FUTURE table created by that same role (a later
-- `pnpm db:migrate` run, e.g. Phase 2's core.customers/core.items/
-- core.sales) is automatically covered without a new grant file.
--
-- Explicitly NOT done, per the approved scope:
--   - No DDL privileges (CREATE/ALTER/DROP) granted to erp_app.
--   - No ownership transfer of any table to erp_app.
--   - No FORCE ROW LEVEL SECURITY — no existing specification
--     (05_MULTI_TENANT_ARCHITECTURE.md §24-26,
--     06_DATABASE_SPECIFICATION.md §10) requires it, and since
--     erp_app is not (and per this design never will be) a table
--     owner, standard RLS already applies to it without FORCE.
--   - No WITH GRANT OPTION — erp_app must never re-delegate.

-- ---------------------------------------------------------------
-- Schema-level USAGE
-- ---------------------------------------------------------------

GRANT USAGE ON SCHEMA control TO erp_app;
GRANT USAGE ON SCHEMA core    TO erp_app;

-- ---------------------------------------------------------------
-- Existing tables — DML only (runtime role, no DDL)
-- ---------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA control TO erp_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA core TO erp_app;

-- ---------------------------------------------------------------
-- Existing sequences (e.g. a future core.change_log.change_sequence,
-- 06 §8.4 / Decision SYNC-002 — bigserial requires USAGE+SELECT on
-- its backing sequence to be writable by a non-owner role; none exist
-- yet in Phase 1, this grant simply ensures none are missed later)
-- ---------------------------------------------------------------

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA control TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core    TO erp_app;

-- ---------------------------------------------------------------
-- Future tables/sequences created by the `erp` owner role
-- ---------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE erp IN SCHEMA control
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE erp IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE erp IN SCHEMA control
  GRANT USAGE, SELECT ON SEQUENCES TO erp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE erp IN SCHEMA core
  GRANT USAGE, SELECT ON SEQUENCES TO erp_app;
