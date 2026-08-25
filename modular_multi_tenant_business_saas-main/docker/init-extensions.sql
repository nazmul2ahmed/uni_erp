-- Required PostgreSQL Extensions
-- Per 06_DATABASE_SPECIFICATION.md v2.0 §15 (Decision DB-008)
-- and 25_DEPLOYMENT_ARCHITECTURE.md §6.2a (Decision DEP-006)

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp') THEN
		CREATE ROLE erp LOGIN PASSWORD 'erp_dev_password' NOSUPERUSER NOBYPASSRLS;
	END IF;
END
$$;

GRANT CONNECT, CREATE ON DATABASE erp_dev TO erp;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist; -- modules.bookings EXCLUDE constraint (Phase 5)
