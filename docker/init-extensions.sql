-- Required PostgreSQL Extensions
-- Per 06_DATABASE_SPECIFICATION.md v2.0 §15 (Decision DB-008)
-- and 25_DEPLOYMENT_ARCHITECTURE.md §6.2a (Decision DEP-006)

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist; -- modules.bookings EXCLUDE constraint (Phase 5)
