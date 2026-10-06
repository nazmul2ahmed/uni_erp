/**
 * Tenant Configuration (Branches/Warehouses/Features) — Integration Test.
 * Per 11_API_SPECIFICATION.md §15, 06_DATABASE_SPECIFICATION.md §4.7/§5.2/§5.3.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { branches, createOwnerDb, db, tenants, tenantFeatures, warehouses, withTenantTransaction, auditEventsPlatform } from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createBranch, listBranches } from "../lib/use-cases/branch";
import { createWarehouse, getWarehouse, listWarehouses, updateWarehouse } from "../lib/use-cases/warehouse";
import { listTenantFeatures, updateTenantFeatures } from "../lib/use-cases/tenant-features";

// Platform audit is append-only for the runtime role (Decision SEC-007): test cleanup uses the owner role.
const ownerConn = createOwnerDb();
afterAll(async () => { await ownerConn.close(); }); // registered first => runs last
let tenantId: string;
let ownerCtx: TenantContext;
let defaultBranchId: string;

async function buildContext(userId: string, membershipId: string): Promise<TenantContext> {
  const membership = await db.query.memberships.findFirst({ where: (m, { eq: e }) => e(m.id, membershipId) });
  if (!membership) throw new Error("Fixture setup failed: membership not found");
  return {
    requestId: randomUUID(),
    userId,
    tenantId,
    membershipId,
    roleId: membership.roleId,
    storageMode: "SHARED",
    permissions: await resolvePermissions(membership.roleId),
    roleKey: await resolveRoleKey(membership.roleId),
  };
}

beforeAll(async () => {
  const reg = await registerOwnerAndTenant({
    email: `tenant-config-test-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: "Tenant Config Test Owner",
    businessName: "Tenant Config Test Business",
  });
  tenantId = reg.tenantId;
  ownerCtx = await buildContext(reg.userId, reg.membershipId);

  const branchRow = await withTenantTransaction(tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq: e }) => e(b.tenantId, tenantId) }));
  defaultBranchId = branchRow!.id;
}, 30_000);

afterAll(async () => {
  if (!tenantId) return;
  await ownerConn.db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.tenantId, tenantId));
  await db.delete(tenantFeatures).where(eq(tenantFeatures.tenantId, tenantId));
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.delete(warehouses).where(eq(warehouses.tenantId, tenantId));
    await tx.delete(branches).where(eq(branches.tenantId, tenantId));
  });
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe("Branches (11 §15)", () => {
  it("creates and lists a branch", async () => {
    const branch = await createBranch(ownerCtx, { name: "Second Branch", code: "BR-2" });
    const list = await listBranches(ownerCtx);
    expect(list.some((b) => b.id === branch.id)).toBe(true);
  });

  it("rejects a duplicate branch code within the same tenant", async () => {
    await createBranch(ownerCtx, { name: "Dup Branch", code: "DUP-BR" });
    await expect(createBranch(ownerCtx, { name: "Dup Branch 2", code: "DUP-BR" })).rejects.toMatchObject({ code: "DUPLICATE_RESOURCE" });
  });
});

describe("Warehouses (11 §15) — including the PATCH-persistence fix", () => {
  it("creates a warehouse under a valid branch", async () => {
    const wh = await createWarehouse(ownerCtx, { name: "Main Warehouse", code: "WH-MAIN", branchId: defaultBranchId });
    expect(wh.branchId).toBe(defaultBranchId);
  });

  it("rejects a branchId that does not belong to this tenant", async () => {
    await expect(createWarehouse(ownerCtx, { name: "Bad Warehouse", code: "WH-BAD", branchId: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects a duplicate warehouse code within the same tenant", async () => {
    await createWarehouse(ownerCtx, { name: "Dup WH", code: "DUP-WH", branchId: defaultBranchId });
    await expect(createWarehouse(ownerCtx, { name: "Dup WH 2", code: "DUP-WH", branchId: defaultBranchId })).rejects.toMatchObject({ code: "DUPLICATE_RESOURCE" });
  });

  it("PATCH actually persists the change (regression test for the fixed fake-update bug)", async () => {
    const wh = await createWarehouse(ownerCtx, { name: "Renamable WH", code: "WH-RENAME", branchId: defaultBranchId });
    const updated = await updateWarehouse(ownerCtx, wh.id, { name: "Renamed Warehouse", isActive: false });
    expect(updated.name).toBe("Renamed Warehouse");
    expect(updated.isActive).toBe(false);

    // Re-fetch via a SEPARATE call (not the same in-memory object) —
    // proves the change was actually written to the database, not
    // just merged into a returned object.
    const refetched = await getWarehouse(ownerCtx, wh.id);
    expect(refetched.name).toBe("Renamed Warehouse");
    expect(refetched.isActive).toBe(false);
  });

  it("listWarehouses reflects a persisted PATCH", async () => {
    const wh = await createWarehouse(ownerCtx, { name: "List Check WH", code: "WH-LIST", branchId: defaultBranchId });
    await updateWarehouse(ownerCtx, wh.id, { name: "List Check Renamed" });
    const list = await listWarehouses(ownerCtx);
    expect(list.find((w) => w.id === wh.id)?.name).toBe("List Check Renamed");
  });
});

describe("Tenant Features (06 §4.7, 05 §68-71)", () => {
  it("lists all known feature keys as disabled by default for a fresh tenant", async () => {
    const features = await listTenantFeatures(ownerCtx);
    expect(features.length).toBeGreaterThan(0);
    expect(features.every((f) => f.enabled === false)).toBe(true);
  });

  it("enables a feature and persists it", async () => {
    await updateTenantFeatures(ownerCtx, { features: [{ featureKey: "rental", enabled: true }] });
    const features = await listTenantFeatures(ownerCtx);
    expect(features.find((f) => f.featureKey === "rental")?.enabled).toBe(true);
    // Untouched keys remain at their default.
    expect(features.find((f) => f.featureKey === "pharmacy")?.enabled).toBe(false);
  });

  it("re-disabling an already-enabled feature updates the existing row, not a duplicate", async () => {
    await updateTenantFeatures(ownerCtx, { features: [{ featureKey: "service", enabled: true }] });
    await updateTenantFeatures(ownerCtx, { features: [{ featureKey: "service", enabled: false }] });
    const rows = await db.query.tenantFeatures.findMany({ where: (tf, { eq: e, and: a }) => a(e(tf.tenantId, tenantId), e(tf.featureKey, "service")) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false);
  });

  // Closes the gap found during Phase-0.5-style verification: `van_sales`
  // was documented (30_MODULE_VAN_SALES.md §1/§9) as a required known-
  // feature-key but was absent from KNOWN_FEATURE_KEYS. This is the same
  // array-driven code path as every other key above (readAllFeatures /
  // updateTenantFeatures) — no new logic, so this test only confirms the
  // key is now reachable, not any new behavior.
  it("van_sales is a known feature key and toggles like any other", async () => {
    const before = await listTenantFeatures(ownerCtx);
    expect(before.find((f) => f.featureKey === "van_sales")?.enabled).toBe(false);

    await updateTenantFeatures(ownerCtx, { features: [{ featureKey: "van_sales", enabled: true }] });
    const after = await listTenantFeatures(ownerCtx);
    expect(after.find((f) => f.featureKey === "van_sales")?.enabled).toBe(true);
  });
});
