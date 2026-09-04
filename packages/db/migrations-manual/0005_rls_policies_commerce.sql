-- Row Level Security policies + CHECK constraints for the Commerce
-- schema batch (Branch/Warehouse/Purchase/Inventory/Sales/Payment/
-- Accounting — 17 tables, per packages/db/schema/commerce.ts).
--
-- Per 05_MULTI_TENANT_ARCHITECTURE.md §24-26 and
-- 06_DATABASE_SPECIFICATION.md v2.0 §5.2-§5.3, §5.8-§5.11, §5.14.
--
-- Applied manually (not via drizzle-kit) after the base schema
-- migration. Run via `pnpm db:migrate`.
--
-- IDEMPOTENCY: follows the exact pattern established in
-- 0001/0002/0004 — DROP POLICY IF EXISTS + CREATE POLICY for
-- policies, pg_constraint-guarded DO $$ blocks for CHECK constraints,
-- CREATE UNIQUE INDEX IF NOT EXISTS for partial uniqueness.
--
-- CORRECTION (Phase 0.5 Reconciliation, second pass, Decision
-- INV-008): an earlier draft of this file claimed "no partial
-- uniqueness needed — all uniqueness here is unconditional." That
-- was wrong for core.stock_balances specifically. See §"Stock
-- Balances Uniqueness" below for the fix. This is the one schema
-- correctness gap found during the commerce.ts verification pass
-- (16 of 17 tables matched 06 v2.0 exactly; stock_balances did not).
--
-- GRANTS: no new grant migration required — the ALTER DEFAULT
-- PRIVILEGES statements in 0003_grant_app_role.sql already cover any
-- future table created by the `erp` owner role in the `core` schema,
-- confirmed for this batch the same way it was already confirmed for
-- the Phase 2 catalog tables (customers/suppliers/items/etc.).
--
-- Defense-in-depth: RLS is ONE layer among several (05 §26) —
-- application-layer tenant scoping (withTenantTransaction) is
-- REQUIRED regardless of RLS being present, per the discipline
-- established (and the bug it prevents) in customer.ts/supplier.ts/
-- item.ts's application-layer use cases.

-- ---------------------------------------------------------------
-- Helper pattern used throughout this file:
--   ALTER TABLE core.<table> ENABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS tenant_isolation_<table> ON core.<table>;
--   CREATE POLICY tenant_isolation_<table> ON core.<table>
--     USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- ---------------------------------------------------------------

ALTER TABLE core.branches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_branches ON core.branches;
CREATE POLICY tenant_isolation_branches ON core.branches
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.warehouses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_warehouses ON core.warehouses;
CREATE POLICY tenant_isolation_warehouses ON core.warehouses
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_purchases ON core.purchases;
CREATE POLICY tenant_isolation_purchases ON core.purchases
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.purchase_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_purchase_items ON core.purchase_items;
CREATE POLICY tenant_isolation_purchase_items ON core.purchase_items
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.stock_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stock_batches ON core.stock_batches;
CREATE POLICY tenant_isolation_stock_batches ON core.stock_batches
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.stock_serials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stock_serials ON core.stock_serials;
CREATE POLICY tenant_isolation_stock_serials ON core.stock_serials
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.sales ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sales ON core.sales;
CREATE POLICY tenant_isolation_sales ON core.sales
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.sale_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sale_items ON core.sale_items;
CREATE POLICY tenant_isolation_sale_items ON core.sale_items
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stock_movements ON core.stock_movements;
CREATE POLICY tenant_isolation_stock_movements ON core.stock_movements
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.stock_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_stock_balances ON core.stock_balances;
CREATE POLICY tenant_isolation_stock_balances ON core.stock_balances
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.receivables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_receivables ON core.receivables;
CREATE POLICY tenant_isolation_receivables ON core.receivables
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.payables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_payables ON core.payables;
CREATE POLICY tenant_isolation_payables ON core.payables
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_payments ON core.payments;
CREATE POLICY tenant_isolation_payments ON core.payments
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.payment_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_payment_allocations ON core.payment_allocations;
CREATE POLICY tenant_isolation_payment_allocations ON core.payment_allocations
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_accounts ON core.accounts;
CREATE POLICY tenant_isolation_accounts ON core.accounts
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.journals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_journals ON core.journals;
CREATE POLICY tenant_isolation_journals ON core.journals
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.journal_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_journal_entries ON core.journal_entries;
CREATE POLICY tenant_isolation_journal_entries ON core.journal_entries
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------
-- Stock Balances Uniqueness (Decision INV-008 — Phase 0.5
-- Reconciliation, second pass).
--
-- 06 v2.0 §5.10 specifies the PK for core.stock_balances as the
-- composite (tenant_id, item_id, warehouse_id, batch_id). That
-- cannot be a literal PostgreSQL PRIMARY KEY here because batch_id
-- is semantically nullable (non-batch-tracked items have no batch)
-- and PostgreSQL forces every PRIMARY KEY column NOT NULL.
--
-- A single UNIQUE INDEX across all four columns (commerce.ts's
-- original draft, and 0002_unique_gunslinger.sql's generated
-- "stock_balances_pk") does NOT close this gap: PostgreSQL treats
-- NULL <> NULL in unique indexes, so multiple stock_balances rows
-- sharing the same (tenant_id, item_id, warehouse_id) with
-- batch_id = NULL would NOT violate that index — silently breaking
-- the "one balance row per item/warehouse" invariant
-- (InventoryLedgerService.recomputeBalance, 09 §3.2) for every
-- non-batch-tracked item (i.e. most Electronics/general-retail
-- items — everything except Pharmacy/FEFO-tracked stock).
--
-- Fix: two partial unique indexes, one per nullability branch.
-- commerce.ts's stock_balances table now declares only a plain
-- (non-unique) lookup index — see that file's Decision INV-008
-- docblock. True uniqueness enforcement lives here.
--
-- Remediation note: if this database was already migrated with the
-- OLD single "stock_balances_pk" UNIQUE index (e.g. via an earlier
-- `pnpm db:migrate` run before this fix), the DROP INDEX below
-- removes it before the corrected indexes are created. Safe to run
-- either on a fresh database or one that already applied the old
-- (buggy) constraint.

DROP INDEX IF EXISTS core.stock_balances_pk;

CREATE UNIQUE INDEX IF NOT EXISTS stock_balances_pk_batched
  ON core.stock_balances (tenant_id, item_id, warehouse_id, batch_id)
  WHERE batch_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stock_balances_pk_unbatched
  ON core.stock_balances (tenant_id, item_id, warehouse_id)
  WHERE batch_id IS NULL;

-- ---------------------------------------------------------------
-- CHECK constraints (defense-in-depth, per 06 §22 — "Application
-- validation একমাত্র protection হবে না"), same idempotent
-- pg_constraint-guarded pattern as 0002_owner_invariant.sql.
-- ---------------------------------------------------------------

-- INV-ACC-001 (08 §11): "Every JournalEntry row has exactly one of
-- {debit, credit} > 0, never both." Application-layer gate
-- (AccountingPostingService.postJournal, per 07 §13.3) is primary;
-- this is the recommended DB-level trigger-equivalent backstop
-- (06 §26).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'journal_entries_exactly_one_side'
      AND conrelid = 'core.journal_entries'::regclass
  ) THEN
    ALTER TABLE core.journal_entries
      ADD CONSTRAINT journal_entries_exactly_one_side
      CHECK (
        (debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)
      );
  END IF;
END $$;

-- Quantity/amount non-negativity backstops for fields the domain
-- layer computes but which should never legitimately go negative
-- regardless of a domain-layer bug (defense-in-depth, not a
-- replacement for 09 §4.7's allow_negative_stock item-level toggle,
-- which governs core.stock_balances.quantity_on_hand — that field is
-- DELIBERATELY allowed to go negative per-item when the toggle is on,
-- so NO CHECK constraint is added to quantity_on_hand here).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sale_items_quantity_positive'
      AND conrelid = 'core.sale_items'::regclass
  ) THEN
    ALTER TABLE core.sale_items
      ADD CONSTRAINT sale_items_quantity_positive
      CHECK (quantity > 0); -- per 07 §7.3 invariant 6
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_items_quantity_positive'
      AND conrelid = 'core.purchase_items'::regclass
  ) THEN
    ALTER TABLE core.purchase_items
      ADD CONSTRAINT purchase_items_quantity_positive
      CHECK (quantity > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_amount_positive'
      AND conrelid = 'core.payments'::regclass
  ) THEN
    ALTER TABLE core.payments
      ADD CONSTRAINT payments_amount_positive
      CHECK (amount > 0);
  END IF;
END $$;

-- Future tenant-owned tables MUST add an equivalent RLS block here
-- (in a new numbered migrations-manual file) as part of their own
-- migration, per the New Table Checklist (05 §126). CHECK
-- constraints follow the DO-block-with-pg_constraint-guard pattern
-- established in 0002_owner_invariant.sql and repeated above — never
-- a bare ALTER TABLE ... ADD CONSTRAINT.