ALTER TABLE core.opening_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_opening_balances ON core.opening_balances;
CREATE POLICY tenant_isolation_opening_balances ON core.opening_balances
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.accounting_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_accounting_periods ON core.accounting_periods;
CREATE POLICY tenant_isolation_accounting_periods ON core.accounting_periods
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE core.accounting_period_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_accounting_period_events ON core.accounting_period_events;
CREATE POLICY tenant_isolation_accounting_period_events ON core.accounting_period_events
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opening_balances_entry_type_check' AND conrelid = 'core.opening_balances'::regclass) THEN
    ALTER TABLE core.opening_balances ADD CONSTRAINT opening_balances_entry_type_check
      CHECK (entry_type IN ('CASH', 'BANK', 'STOCK', 'CUSTOMER_RECEIVABLE', 'SUPPLIER_PAYABLE', 'CAPITAL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opening_balances_amount_check' AND conrelid = 'core.opening_balances'::regclass) THEN
    ALTER TABLE core.opening_balances ADD CONSTRAINT opening_balances_amount_check
      CHECK (amount > 0 AND paid_amount >= 0 AND balance >= 0 AND amount = paid_amount + balance);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opening_balances_status_check' AND conrelid = 'core.opening_balances'::regclass) THEN
    ALTER TABLE core.opening_balances ADD CONSTRAINT opening_balances_status_check
      CHECK (
        (status = 'OPEN' AND paid_amount = 0 AND balance = amount)
        OR (status = 'PARTIAL' AND paid_amount > 0 AND balance > 0)
        OR (status = 'SETTLED' AND balance = 0 AND paid_amount = amount)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'opening_balances_party_shape_check' AND conrelid = 'core.opening_balances'::regclass) THEN
    ALTER TABLE core.opening_balances ADD CONSTRAINT opening_balances_party_shape_check
      CHECK (
        (entry_type = 'CUSTOMER_RECEIVABLE' AND customer_id IS NOT NULL AND supplier_id IS NULL AND account_code IS NULL)
        OR (entry_type = 'SUPPLIER_PAYABLE' AND supplier_id IS NOT NULL AND customer_id IS NULL AND account_code IS NULL)
        OR (entry_type = 'CAPITAL' AND customer_id IS NULL AND supplier_id IS NULL AND account_code IS NOT NULL)
        OR (entry_type IN ('CASH', 'BANK', 'STOCK') AND customer_id IS NULL AND supplier_id IS NULL AND account_code IS NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounting_periods_range_check' AND conrelid = 'core.accounting_periods'::regclass) THEN
    ALTER TABLE core.accounting_periods ADD CONSTRAINT accounting_periods_range_check
      CHECK (period_start <= period_end);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounting_periods_status_check' AND conrelid = 'core.accounting_periods'::regclass) THEN
    ALTER TABLE core.accounting_periods ADD CONSTRAINT accounting_periods_status_check
      CHECK (status IN ('OPEN', 'CLOSED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounting_period_events_action_check' AND conrelid = 'core.accounting_period_events'::regclass) THEN
    ALTER TABLE core.accounting_period_events ADD CONSTRAINT accounting_period_events_action_check
      CHECK (action IN ('CLOSE', 'REOPEN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_allocations_type_check' AND conrelid = 'core.payment_allocations'::regclass) THEN
    ALTER TABLE core.payment_allocations ADD CONSTRAINT payment_allocations_type_check
      CHECK (
        (allocated_to_type = 'ADVANCE' AND allocated_to_id IS NULL)
        OR (allocated_to_type IN ('SALE', 'PURCHASE', 'EXPENSE', 'OPENING_BALANCE') AND allocated_to_id IS NOT NULL)
      );
  END IF;
END $$;
