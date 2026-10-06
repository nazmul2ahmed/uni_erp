-- 0009_expenses_rls.sql
-- Expense domain (06 s5.13, 07 s14, Decisions EXP-001..EXP-003):
--   core.expense_categories, core.expenses -- RLS, CHECKs, partial/functional indexes.
--
-- Applied after the drizzle migration that creates the tables. Idempotent
-- (re-run on every `db:migrate`): DROP POLICY IF EXISTS + CREATE POLICY,
-- pg_constraint-guarded DO blocks, CREATE UNIQUE INDEX IF NOT EXISTS.
-- GRANTs: covered by ALTER DEFAULT PRIVILEGES in 0003_grant_app_role.sql.
--
-- core.expenses is APPEND-ONLY for the runtime role: tenant-scoped SELECT and
-- INSERT policies exist, and there is deliberately NO UPDATE / DELETE policy,
-- so with RLS enabled `erp_app` cannot change or remove a posted expense.
-- A mistake is corrected by reversal + a new record (08 s10.3), never an edit.

ALTER TABLE core.expense_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_expense_categories ON core.expense_categories;
CREATE POLICY tenant_isolation_expense_categories ON core.expense_categories
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_expenses ON core.expenses;
DROP POLICY IF EXISTS tenant_select_expenses ON core.expenses;
DROP POLICY IF EXISTS tenant_insert_expenses ON core.expenses;
CREATE POLICY tenant_select_expenses ON core.expenses
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_insert_expenses ON core.expenses
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Category names are unique per tenant, case-insensitively ("Rent" == "rent").
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_tenant_name_lower_unique
  ON core.expense_categories (tenant_id, lower(name));

-- An expense is a positive amount (a refund/negative is a reversal, not a row).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expenses_amount_positive'
      AND conrelid = 'core.expenses'::regclass
  ) THEN
    ALTER TABLE core.expenses
      ADD CONSTRAINT expenses_amount_positive CHECK (amount > 0);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expenses_paid_via_valid'
      AND conrelid = 'core.expenses'::regclass
  ) THEN
    ALTER TABLE core.expenses
      ADD CONSTRAINT expenses_paid_via_valid CHECK (paid_via IN ('CASH', 'BANK'));
  END IF;
END
$$;
