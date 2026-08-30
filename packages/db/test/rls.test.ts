import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

// Must connect as the non-owner, non-superuser erp_app role — testing
// RLS via the `erp` owner/superuser connection (DATABASE_URL) would
// trivially pass regardless of policy correctness, since `erp`
// bypasses RLS entirely (RLS Role Architecture Decision).
const connectionString =
  process.env.DATABASE_URL_APP ?? "postgres://erp_app:erp_app_dev_password@localhost:5432/erp_dev";

test("RLS exposes only the active tenant's business profile", async () => {
  const sql = postgres(connectionString, { max: 1 });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  // owner_required_when_active (packages/db/migrations-manual/
  // 0002_owner_invariant.sql, Decision TEN-001) requires
  // owner_membership_id whenever status='ACTIVE'. This column has no
  // FK constraint (packages/db/schema/control.ts — plain uuid), so
  // any non-null placeholder satisfies the CHECK for this isolation
  // fixture; a real control.memberships row is unnecessary since
  // this test exercises RLS, not the ownership invariant itself.
  const ownerMembershipA = randomUUID();
  const ownerMembershipB = randomUUID();

  try {
    await sql`
      INSERT INTO control.tenants (id, name, status, storage_mode, owner_membership_id)
      VALUES
        (${tenantA}, 'RLS Test A', 'ACTIVE', 'SHARED', ${ownerMembershipA}),
        (${tenantB}, 'RLS Test B', 'ACTIVE', 'SHARED', ${ownerMembershipB})
    `;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      await tx`INSERT INTO core.business_profiles (tenant_id, name) VALUES (${tenantA}, 'Profile A')`;
    });
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      await tx`INSERT INTO core.business_profiles (tenant_id, name) VALUES (${tenantB}, 'Profile B')`;
    });

    const visibleToA = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      return tx`SELECT name FROM core.business_profiles ORDER BY name`;
    });
    const visibleToB = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
      return tx`SELECT name FROM core.business_profiles ORDER BY name`;
    });

    assert.deepEqual(visibleToA.map((row) => row.name), ["Profile A"]);
    assert.deepEqual(visibleToB.map((row) => row.name), ["Profile B"]);
  } finally {
    await sql`DELETE FROM control.tenants WHERE id IN (${tenantA}, ${tenantB})`;
    await sql.end();
  }
});