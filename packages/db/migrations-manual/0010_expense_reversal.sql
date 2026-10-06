-- 0010_expense_reversal.sql
-- Expense reversal (08 s5.9 / s10.3, Decision EXP-005):
--   1. core.expense_reversals: append-only RLS + reason CHECK
--   2. core.journals: a journal can be reversed at most once (partial unique index)
--   3. permission `expenses.reverse` + ONE-TIME backfill
-- Idempotent (re-run on every `db:migrate`).

-- 1. Append-only for the runtime role: tenant SELECT + INSERT, no UPDATE/DELETE policy.
ALTER TABLE core.expense_reversals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_select_expense_reversals ON core.expense_reversals;
DROP POLICY IF EXISTS tenant_insert_expense_reversals ON core.expense_reversals;
CREATE POLICY tenant_select_expense_reversals ON core.expense_reversals
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_insert_expense_reversals ON core.expense_reversals
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expense_reversals_reason_present'
      AND conrelid = 'core.expense_reversals'::regclass
  ) THEN
    ALTER TABLE core.expense_reversals
      ADD CONSTRAINT expense_reversals_reason_present CHECK (char_length(btrim(reason)) >= 3);
  END IF;
END
$$;

-- 2. Defense-in-depth beside the application check: reversing the same journal twice
--    would double-negate it. Reversal journals point at the original via reference_id (08 s5.9).
CREATE UNIQUE INDEX IF NOT EXISTS journals_one_reversal_per_original
  ON core.journals (tenant_id, reference_id)
  WHERE reference_type = 'REVERSAL';

-- 3. Permission + one-time backfill. Guarded on the permission row NOT existing yet, because
--    manual migrations re-run on every `db:migrate` and an unguarded backfill would re-grant
--    the permission to roles an admin deliberately removed it from (same pattern as 0008).
--    Behaviour-preserving intent: whoever could manage expenses (expenses.manage) keeps being
--    able to correct them. Upgrade order assumption: migrate BEFORE seed.
DO $$
DECLARE
  v_permission_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM control.permissions WHERE key = 'expenses.reverse') THEN
    INSERT INTO control.permissions (key, description)
    VALUES (
      'expenses.reverse',
      'Reverse a posted expense (08 10.3, Decision EXP-005) -- a financial correction, so separate from create/manage'
    )
    RETURNING id INTO v_permission_id;

    INSERT INTO control.role_permissions (role_id, permission_id)
    SELECT rp.role_id, v_permission_id
    FROM control.role_permissions rp
    JOIN control.permissions p ON p.id = rp.permission_id
    WHERE p.key = 'expenses.manage'
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;
