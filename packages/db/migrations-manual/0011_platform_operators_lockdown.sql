-- 0011_platform_operators_lockdown.sql
-- Platform operator hardening (ADR-001, Decision PLT-001). Idempotent; runs on
-- every `db:migrate`, ORDERED AFTER 0003_grant_app_role.sql, which re-grants
-- DML on ALL control tables to erp_app each time -- so the REVOKE below must
-- come later in the same run (manual migrations are applied in file order).

-- 1. The web app's database role can READ operators but never create,
--    change or remove one. Operators are minted only by the owner role (CLI).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON control.platform_operators FROM erp_app;

-- 2. A revoked operator must carry a revoke time.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_operators_revoked_has_time'
      AND conrelid = 'control.platform_operators'::regclass
  ) THEN
    ALTER TABLE control.platform_operators
      ADD CONSTRAINT platform_operators_revoked_has_time
      CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL);
  END IF;
END
$$;

-- 3. Segregation of duties as a DATABASE fact (05 88; ADR-001 rule 3). An account is
--    either an ACTIVE platform operator OR an ACTIVE tenant member -- never both.
--    Defence in depth: the application checks first and returns a friendly error;
--    these triggers hold even if an application bug skips the check. They fire for
--    every role (RLS and table privileges do not bypass triggers).
CREATE OR REPLACE FUNCTION control.reject_operator_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM control.platform_operators o
    WHERE o.user_id = NEW.user_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'platform operators cannot hold an active tenant membership'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS memberships_reject_operator ON control.memberships;
CREATE TRIGGER memberships_reject_operator
  BEFORE INSERT OR UPDATE OF status, user_id ON control.memberships
  FOR EACH ROW EXECUTE FUNCTION control.reject_operator_membership();

CREATE OR REPLACE FUNCTION control.reject_member_as_operator() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM control.memberships m
    WHERE m.user_id = NEW.user_id AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'an account with an active tenant membership cannot be a platform operator'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS platform_operators_reject_member ON control.platform_operators;
CREATE TRIGGER platform_operators_reject_member
  BEFORE INSERT OR UPDATE OF status, user_id ON control.platform_operators
  FOR EACH ROW EXECUTE FUNCTION control.reject_member_as_operator();
