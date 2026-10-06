-- 0008_reports_view_permission.sql
-- Decision RPT-001 (11 s19): introduce permission `reports.view`.
--
-- ONE-TIME backfill, guarded on the permission row not existing yet.
-- manual migrations are re-run on every `db:migrate`, so an unguarded
-- backfill would silently re-grant reports.view to roles from which an
-- admin had deliberately removed it. Guard = first run only.
--
-- Behaviour-preserving: every role that held `accounting.view` (the
-- permission that previously gated the report routes) receives
-- `reports.view`, including tenant-custom roles, so no existing user loses
-- report access on upgrade.
--
-- Upgrade order assumption: `db:migrate` BEFORE `db:seed` (AGENTS.md).
-- If the seed ran first the permission row already exists, the backfill is
-- skipped, and tenant-custom roles must be re-granted via role management.
DO $$
DECLARE
  v_permission_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM control.permissions WHERE key = 'reports.view') THEN
    INSERT INTO control.permissions (key, description)
    VALUES (
      'reports.view',
      'View dashboard and operational reports (11 s19). Gates the report endpoints; financial widgets/figures additionally require accounting.view (12 s8). Seeded OWNER + MANAGER only -- STAFF excluded as a conservative default pending business confirmation'
    )
    RETURNING id INTO v_permission_id;

    INSERT INTO control.role_permissions (role_id, permission_id)
    SELECT rp.role_id, v_permission_id
    FROM control.role_permissions rp
    JOIN control.permissions p ON p.id = rp.permission_id
    WHERE p.key = 'accounting.view'
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;
