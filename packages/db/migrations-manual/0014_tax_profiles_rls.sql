-- Tenant isolation and constraints for the Phase 2 TaxProfile table.
-- The generated migration adds the table, item/profile foreign keys,
-- and historical tax snapshots; this migration adds policies and
-- invariants which Drizzle does not model.

ALTER TABLE core.tax_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_tax_profiles ON core.tax_profiles;
CREATE POLICY tenant_isolation_tax_profiles ON core.tax_profiles
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE UNIQUE INDEX IF NOT EXISTS tax_profiles_tenant_name_unique
  ON core.tax_profiles (tenant_id, lower(name));

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tax_profiles_rate_nonnegative'
  ) THEN
    ALTER TABLE core.tax_profiles
      ADD CONSTRAINT tax_profiles_rate_nonnegative CHECK (rate >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tax_profiles_exclusive_only'
  ) THEN
    ALTER TABLE core.tax_profiles
      ADD CONSTRAINT tax_profiles_exclusive_only CHECK (is_inclusive = false);
  END IF;
END $$;
