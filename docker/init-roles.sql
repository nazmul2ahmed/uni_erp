-- Runtime/application PostgreSQL role.
-- Per the RLS Role Architecture Decision (approved).
--
-- Role topology:
--   erp      = migration/DDL/owner role (unchanged) — POSTGRES_USER
--              bootstrap superuser (docker/docker-compose.yml), owns
--              every table created by `pnpm db:migrate`.
--   erp_app  = runtime/application role — NOSUPERUSER, NOBYPASSRLS,
--              owns nothing. This is the role that must actually be
--              subject to Row Level Security
--              (05_MULTI_TENANT_ARCHITECTURE.md §24-26) for RLS to
--              have any effect — a superuser or table owner is
--              unconditionally exempt from RLS regardless of policy
--              correctness.
--
-- Runs once, automatically, ONLY on a FRESH PostgreSQL data volume
-- (docker-entrypoint-initdb.d semantics — never re-applied to an
-- already-initialized volume; mounted via docker/docker-compose.yml).
--
-- Deliberately does NOT grant schema/table privileges here: `control`
-- and `core` do not exist yet at this point in the bootstrap sequence
-- (they are created later by `pnpm db:migrate`). Those grants live in
-- packages/db/migrations-manual/0003_grant_app_role.sql instead,
-- applied automatically by the existing manual-migration runner
-- (packages/db/migrate.ts) once the schemas/tables exist.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    CREATE ROLE erp_app
      LOGIN
      PASSWORD 'erp_app_dev_password'
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END
$$;
