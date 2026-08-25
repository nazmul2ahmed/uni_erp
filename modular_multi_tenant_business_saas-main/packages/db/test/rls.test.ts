import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://erp:erp_dev_password@localhost:5432/erp_dev";

test("RLS exposes only the active tenant's business profile", async () => {
  const sql = postgres(connectionString, { max: 1 });
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  try {
    await sql`
      INSERT INTO control.tenants (id, name, status, storage_mode)
      VALUES
        (${tenantA}, 'RLS Test A', 'ACTIVE', 'SHARED'),
        (${tenantB}, 'RLS Test B', 'ACTIVE', 'SHARED')
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