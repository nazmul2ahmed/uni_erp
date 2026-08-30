-- Owner-Membership Invariant — DB-level null-safety backstop.
-- Per 05_MULTI_TENANT_ARCHITECTURE.md §75a (Decision TEN-001, INV-OWN-001)
-- and 06_DATABASE_SPECIFICATION.md v2.0 §4.2 / §17 Decision DB-010.
--
-- This is a HYBRID enforcement model — this constraint is ONLY the
-- null-safety layer. It does not validate WHO a legitimate owner is;
-- that is application-layer responsibility:
--   INV-OWN-002: RemoveMembershipUseCase / SuspendMembershipUseCase /
--     UpdateMembershipRoleUseCase reject any attempt to remove/suspend
--     the membership currently pointed to by owner_membership_id,
--     surfacing OWNER_TRANSFER_REQUIRED (409) instead.
--   INV-OWN-003: TransferOwnershipUseCase sets the new owner and clears/
--     reassigns the old owner's role within a single atomic transaction.
--
-- Applied manually (not via drizzle-kit, which does not model CHECK
-- constraints referencing multiple columns as cleanly as raw SQL for
-- this project's conventions — see 0001_rls_policies.sql for the same
-- manual-migration pattern). Run via `pnpm db:migrate` after the base
-- schema migration and after 0001_rls_policies.sql.
--
-- IDEMPOTENCY NOTE: PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`
-- syntax, so this migration wraps the ALTER TABLE in a DO block that
-- checks pg_constraint before adding — making this migration safely
-- re-runnable, per 25_DEPLOYMENT_ARCHITECTURE.md §8's requirement
-- that every migration step be backward-compatible / re-runnable
-- within a rolling deploy's overlap window. (Same regression class,
-- and same fix pattern, as 0001_rls_policies.sql's CREATE POLICY guard.)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'owner_required_when_active'
      AND conrelid = 'control.tenants'::regclass
  ) THEN
    ALTER TABLE control.tenants
      ADD CONSTRAINT owner_required_when_active
      CHECK (status != 'ACTIVE' OR owner_membership_id IS NOT NULL);
  END IF;
END $$;

-- Compatibility note: this constraint is satisfied by the existing
-- registerOwnerAndTenant() flow (apps/web/lib/tenant-onboarding.ts)
-- without modification — the tenant row transitions from
-- (status='PROVISIONING', owner_membership_id=NULL) to
-- (status='ACTIVE', owner_membership_id=<uuid>) via a SINGLE UPDATE
-- statement that sets both columns together, so the constraint is
-- never violated at any statement boundary (PostgreSQL CHECK
-- constraints are evaluated per-statement, not deferred, by default;
-- no DEFERRABLE clause is required here since no intermediate
-- statement ever produces the disallowed combination).