-- 0012_audit_platform_append_only.sql
-- Decision SEC-007 (06 s4.9: "append-only, no update/delete from the application layer").
-- The runtime role may add and read platform audit events, never change or remove them.
-- Idempotent; ORDERED AFTER 0003_grant_app_role.sql, which re-grants DML on every control
-- table to erp_app on each migrate -- so this REVOKE must run later in the same pass.
-- (Deleting a tenant still works: FK referential actions execute as the table owner.)
REVOKE UPDATE, DELETE, TRUNCATE ON control.audit_events_platform FROM erp_app;
