/**
 * reports.view permission catalog + preset-role mapping -- Integration Test.
 * Per 11_API_SPECIFICATION.md s19, Decision RPT-001.
 *
 * Guards the seeded invariant that the report endpoints' permission exists
 * and is granted to OWNER + MANAGER only (STAFF excluded as a conservative
 * default), and that every preset role holding it also holds the
 * accounting.view it replaced on the report routes (no role gains report
 * access without the prior gate's holders).
 */
import { describe, expect, it } from "vitest";
import { resolvePermissions } from "../lib/guard";
import { db } from "@erp/db";

async function presetRolePermissions(key: string): Promise<string[]> {
  const role = await db.query.roles.findFirst({
    where: (r, { and, eq, isNull }) => and(isNull(r.tenantId), eq(r.key, key)),
  });
  if (!role) throw new Error(`Preset role ${key} not seeded -- run pnpm db:seed`);
  return resolvePermissions(role.id);
}

describe("reports.view (Decision RPT-001)", () => {
  it("exists in the platform permission catalog exactly once", async () => {
    const rows = await db.query.permissions.findMany({ where: (p, { eq }) => eq(p.key, "reports.view") });
    expect(rows).toHaveLength(1);
  });

  it("is granted to OWNER and MANAGER", async () => {
    expect(await presetRolePermissions("OWNER")).toContain("reports.view");
    expect(await presetRolePermissions("MANAGER")).toContain("reports.view");
  });

  it("is NOT granted to STAFF by default", async () => {
    expect(await presetRolePermissions("STAFF")).not.toContain("reports.view");
  });

  it("every preset role with reports.view also holds accounting.view (no access widening vs. the prior gate)", async () => {
    for (const key of ["OWNER", "MANAGER", "STAFF"]) {
      const perms = await presetRolePermissions(key);
      if (perms.includes("reports.view")) expect(perms).toContain("accounting.view");
    }
  });
});
