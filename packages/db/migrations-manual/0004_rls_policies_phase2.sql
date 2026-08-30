-- Row Level Security policies + conditional UNIQUE constraints for
-- Phase 2 core entities (Customer / Supplier / Item / ItemCategory /
-- Brand / Unit).
--
-- Per 05_MULTI_TENANT_ARCHITECTURE.md §24-26 (Decision TEN-002 for
-- the SET LOCAL discipline this policy depends on) and
-- 06_DATABASE_SPECIFICATION.md v2.0 §5.4-§5.7.
--
-- Applied manually (not via drizzle-kit, which does not model RLS or
-- partial/conditional UNIQUE constraints) after the base schema
-- migration. Run via `pnpm db:migrate`.
--
-- IDEMPOTENCY: follows the exact pattern established in
-- 0001_rls_policies.sql (DROP POLICY IF EXISTS + CREATE POLICY) and
-- extends it to conditional UNIQUE constraints via
-- CREATE UNIQUE INDEX IF NOT EXISTS (naturally idempotent — no
-- DROP-then-CREATE needed for indexes, unlike named policies).
--
-- Defense-in-depth: RLS is ONE layer among several (05 §26) —
-- application-layer tenant scoping (packages/db/client.ts,
-- withTenantTransaction) is REQUIRED regardless of RLS being present.

-- ---------------------------------------------------------------
-- core.units
-- ---------------------------------------------------------------

ALTER TABLE core.units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_units ON core.units;

CREATE POLICY tenant_isolation_units ON core.units
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------
-- core.brands
-- ---------------------------------------------------------------

ALTER TABLE core.brands ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_brands ON core.brands;

CREATE POLICY tenant_isolation_brands ON core.brands
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------
-- core.item_categories
-- ---------------------------------------------------------------

ALTER TABLE core.item_categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_item_categories ON core.item_categories;

CREATE POLICY tenant_isolation_item_categories ON core.item_categories
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------
-- core.customers
-- ---------------------------------------------------------------

ALTER TABLE core.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_customers ON core.customers;

CREATE POLICY tenant_isolation_customers ON core.customers
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Conditional uniqueness, per 06 v2.0 §5.4:
--   "UNIQUE(tenant_id, phone) where phone IS NOT NULL AND is_walk_in = false"
-- Not expressible via Drizzle's schema builder for this project's
-- Drizzle 0.33 conventions (see schema/core.ts docblock) — applied
-- here as a partial unique index, which is PostgreSQL's canonical
-- mechanism for a conditional UNIQUE constraint.
CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_phone_unique
  ON core.customers (tenant_id, phone)
  WHERE phone IS NOT NULL AND is_walk_in = false;

-- ---------------------------------------------------------------
-- core.suppliers
-- ---------------------------------------------------------------

ALTER TABLE core.suppliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_suppliers ON core.suppliers;

CREATE POLICY tenant_isolation_suppliers ON core.suppliers
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Conditional uniqueness, per 06 v2.0 §5.5: "UNIQUE(tenant_id, phone)
-- where applicable" — suppliers has no is_walk_in equivalent, so the
-- condition is simply phone IS NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_tenant_phone_unique
  ON core.suppliers (tenant_id, phone)
  WHERE phone IS NOT NULL;

-- ---------------------------------------------------------------
-- core.items
-- ---------------------------------------------------------------

ALTER TABLE core.items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_items ON core.items;

CREATE POLICY tenant_isolation_items ON core.items
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Conditional uniqueness, per 06 v2.0 §5.6:
--   "UNIQUE(tenant_id, sku) where sku IS NOT NULL"
CREATE UNIQUE INDEX IF NOT EXISTS items_tenant_sku_unique
  ON core.items (tenant_id, sku)
  WHERE sku IS NOT NULL;

-- ---------------------------------------------------------------
-- Fail-closed default (restated from 0001_rls_policies.sql): if
-- app.tenant_id is never set, current_setting with `true`
-- (missing_ok) returns NULL, and NULL = anything is NULL (never
-- TRUE) in Postgres — so every policy above denies by default rather
-- than accidentally allowing, per 05 §159 Fail Closed Principle.
--
-- Grants: no new grant migration is required for these tables — the
-- ALTER DEFAULT PRIVILEGES statements in
-- migrations-manual/0003_grant_app_role.sql already cover any FUTURE
-- table created by the `erp` owner role in the `core` schema,
-- including all six tables above.
--
-- Future tenant-owned tables (Phase 2 continued: core.sales,
-- core.purchases, core.stock_movements, ...) MUST add an equivalent
-- ENABLE ROW LEVEL SECURITY + DROP POLICY IF EXISTS + CREATE POLICY
-- block here (in a new numbered migrations-manual file) as part of
-- their own migration, per the New Table Checklist (05 §126).