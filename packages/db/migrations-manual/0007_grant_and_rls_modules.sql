-- Grants, RLS policies, and CHECK constraints for:
--   (a) the `modules` PostgreSQL schema (its FIRST tables — Van/Route
--       Sales custody ledger, per packages/db/schema/modules.ts,
--       30_MODULE_VAN_SALES.md §9)
--   (b) the core.receivables / core.return_lines amendments in the
--       SAME migration batch (commerce.ts, Decisions VAN-003/VAN-006)
--
-- Per 0003_grant_app_role.sql's own explicit note: "modules... schemas
-- are out of scope for this file — they do not exist yet at Phase 1.
-- A follow-up migrations-manual file must extend this exact pattern
-- to them once those schemas are introduced." This is that follow-up.
--
-- IDEMPOTENCY: same pattern as every prior file in this directory —
-- GRANT/ALTER DEFAULT PRIVILEGES are safely re-runnable as-is; DROP
-- POLICY IF EXISTS + CREATE POLICY for RLS; CREATE UNIQUE INDEX IF
-- NOT EXISTS for partial uniqueness; pg_constraint-guarded DO $$
-- blocks for CHECK constraints. Applied via `pnpm db:migrate`.

-- ---------------------------------------------------------------
-- Schema-level USAGE + DML grants (mirrors 0003's control/core block)
-- ---------------------------------------------------------------

GRANT USAGE ON SCHEMA modules TO erp_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA modules TO erp_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA modules TO erp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE erp IN SCHEMA modules
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE erp IN SCHEMA modules
  GRANT USAGE, SELECT ON SEQUENCES TO erp_app;

-- ---------------------------------------------------------------
-- RLS — tenant isolation, per 05 §24-26 / 06 §3.1 (modules schema
-- is tenant-scoped, colocated with core in Shared mode)
-- ---------------------------------------------------------------

ALTER TABLE modules.rep_stock_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_rep_stock_assignments ON modules.rep_stock_assignments;
CREATE POLICY tenant_isolation_rep_stock_assignments ON modules.rep_stock_assignments
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE modules.rep_stock_assignment_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_rep_stock_assignment_lines ON modules.rep_stock_assignment_lines;
CREATE POLICY tenant_isolation_rep_stock_assignment_lines ON modules.rep_stock_assignment_lines
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE modules.rep_stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_rep_stock_movements ON modules.rep_stock_movements;
CREATE POLICY tenant_isolation_rep_stock_movements ON modules.rep_stock_movements
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE modules.rep_custody_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_rep_custody_balances ON modules.rep_custody_balances;
CREATE POLICY tenant_isolation_rep_custody_balances ON modules.rep_custody_balances
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ---------------------------------------------------------------
-- Decision VAN-009: at most one ISSUED/RECONCILING assignment per rep
-- ---------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS rep_one_active_assignment
  ON modules.rep_stock_assignments (tenant_id, rep_membership_id)
  WHERE status IN ('ISSUED', 'RECONCILING');

-- ---------------------------------------------------------------
-- rep_custody_balances uniqueness — same NULL-uniqueness gap as
-- core.stock_balances (Decision INV-008), same fix: two partial
-- unique indexes, one per batch_id nullability branch.
-- ---------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS rep_custody_balances_pk_batched
  ON modules.rep_custody_balances (tenant_id, rep_membership_id, item_id, batch_id)
  WHERE batch_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS rep_custody_balances_pk_unbatched
  ON modules.rep_custody_balances (tenant_id, rep_membership_id, item_id)
  WHERE batch_id IS NULL;

-- ---------------------------------------------------------------
-- CHECK constraints — defense-in-depth for columns Drizzle's
-- text(..., {enum:[...]}) types only at the TypeScript level (NOT
-- the database level — confirmed by inspecting migrations/
-- 0006_low_chameleon.sql's generated DDL, which emits plain `text`
-- columns with no CHECK clause). Same pg_constraint-guarded DO $$
-- pattern as 0002_owner_invariant.sql / 0005's journal_entries CHECK.
-- ---------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rep_stock_assignments_status_enum'
      AND conrelid = 'modules.rep_stock_assignments'::regclass
  ) THEN
    ALTER TABLE modules.rep_stock_assignments
      ADD CONSTRAINT rep_stock_assignments_status_enum
      CHECK (status IN ('ISSUED', 'RECONCILING', 'RECONCILED', 'CANCELLED'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rep_stock_movements_type_enum'
      AND conrelid = 'modules.rep_stock_movements'::regclass
  ) THEN
    ALTER TABLE modules.rep_stock_movements
      ADD CONSTRAINT rep_stock_movements_type_enum
      CHECK (movement_type IN ('ISSUE', 'SALE', 'RETURN_GOOD', 'RETURN_DAMAGED', 'RETURN_EXPIRED', 'RETURN_PENDING'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'return_lines_condition_enum'
      AND conrelid = 'core.return_lines'::regclass
  ) THEN
    ALTER TABLE core.return_lines
      ADD CONSTRAINT return_lines_condition_enum
      CHECK (condition IN ('RESELLABLE', 'UNSELLABLE'));
  END IF;
END $$;

-- Decision VAN-006: partyType-consistent receivable shape. A CUSTOMER
-- receivable MUST retain its full pre-existing shape (customer_id AND
-- sale_id both set) — this is additive protection preserving the
-- ORIGINAL NOT NULL invariant for every existing/future customer
-- receivable, not a loosening of it. A REP receivable MUST have
-- rep_membership_id set and customer_id/sale_id NULL (a cash-shortfall
-- receivable has no originating sale or customer).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'receivables_party_type_enum'
      AND conrelid = 'core.receivables'::regclass
  ) THEN
    ALTER TABLE core.receivables
      ADD CONSTRAINT receivables_party_type_enum
      CHECK (party_type IN ('CUSTOMER', 'REP'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'receivables_party_shape'
      AND conrelid = 'core.receivables'::regclass
  ) THEN
    ALTER TABLE core.receivables
      ADD CONSTRAINT receivables_party_shape
      CHECK (
        (party_type = 'CUSTOMER' AND customer_id IS NOT NULL AND sale_id IS NOT NULL AND rep_membership_id IS NULL)
        OR
        (party_type = 'REP' AND rep_membership_id IS NOT NULL AND customer_id IS NULL AND sale_id IS NULL)
      );
  END IF;
END $$;

-- Future modules-schema tables MUST add an equivalent RLS block here
-- (in a new numbered migrations-manual file), per the New Table
-- Checklist (05 §126) — same requirement already noted at the end of
-- 0005_rls_policies_commerce.sql for core.* tables, now restated for
-- modules.*.
