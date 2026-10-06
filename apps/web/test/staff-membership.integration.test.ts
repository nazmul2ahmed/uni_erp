/**
 * Staff/Membership — Integration Test.
 * Per 05_MULTI_TENANT_ARCHITECTURE.md §75a-78, 11_API_SPECIFICATION.md §15.
 *
 * Exercises lib/use-cases/staff.ts and lib/use-cases/role.ts directly
 * against a real PostgreSQL instance — these operate on control.*
 * tables which carry NO RLS, so correctness depends entirely on the
 * application-layer tenantId filtering demonstrated here (not a DB
 * policy backstop), making a real-DB test the only meaningful way to
 * verify the tenant-isolation claims these use cases make.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { auditEventsPlatform, createOwnerDb, db, memberships, roles, tenants, users, withPlatformTransaction } from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { inviteStaff, listStaff, transferOwnership, updateMembership } from "../lib/use-cases/staff";
import { createRole, listRoles, updateRole } from "../lib/use-cases/role";

// Platform audit is append-only for the runtime role (Decision SEC-007): test cleanup uses the owner role.
const ownerConn = createOwnerDb();
afterAll(async () => { await ownerConn.close(); }); // registered first => runs last
let tenantAId: string;
let tenantBId: string; // second tenant, for cross-tenant IDOR checks
let ownerCtx: TenantContext;
let ownerUserId: string;
let managerRoleId: string; // platform preset, usable by any tenant
let tenantBCustomRoleId: string; // belongs to Tenant B — must be unreachable from Tenant A

async function buildContext(tenantId: string, userId: string, membershipId: string): Promise<TenantContext> {
  const membership = await db.query.memberships.findFirst({ where: eq(memberships.id, membershipId) });
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
  const regA = await registerOwnerAndTenant({
    email: `staff-test-owner-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: "Staff Test Owner",
    businessName: "Staff Test Business A",
  });
  tenantAId = regA.tenantId;
  ownerUserId = regA.userId;
  ownerCtx = await buildContext(tenantAId, regA.userId, regA.membershipId);

  const regB = await registerOwnerAndTenant({
    email: `staff-test-owner-b-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: "Staff Test Owner B",
    businessName: "Staff Test Business B",
  });
  tenantBId = regB.tenantId;
  const ownerBCtx = await buildContext(tenantBId, regB.userId, regB.membershipId);

  const manager = await db.query.roles.findFirst({ where: and(isNull(roles.tenantId), eq(roles.key, "MANAGER")) });
  if (!manager) throw new Error("Fixture setup failed: MANAGER preset role missing — run pnpm db:seed");
  managerRoleId = manager.id;

  // A role belonging to TENANT B, used to prove Tenant A cannot
  // reference it (IDOR — 05 §92, applied to a foreign-key selection
  // rather than a direct resource load).
  const tenantBRole = await createRole(ownerBCtx, { key: "TENANT_B_ONLY", name: "Tenant B Only Role", permissionKeys: ["sales.view"] });
  tenantBCustomRoleId = tenantBRole.id;
}, 30_000);

afterAll(async () => {
  for (const tenantId of [tenantAId, tenantBId]) {
    if (!tenantId) continue;
    await ownerConn.db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.tenantId, tenantId));
    await db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await db.delete(roles).where(eq(roles.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
});

describe("Staff invite (11 §15, 05 §12 multi-tenant-membership)", () => {
  it("creates a brand-new user + membership, returning a one-time temporary password", async () => {
    const result = await inviteStaff(ownerCtx, { email: `new-staff-${randomUUID()}@example.test`, fullName: "New Staff", roleId: managerRoleId });
    expect(result.temporaryPassword).toBeTruthy();
    expect(result.membership.status).toBe("ACTIVE");
  });

  it("adds a membership for an ALREADY-EXISTING platform user without creating a duplicate user row", async () => {
    const email = `shared-user-${randomUUID()}@example.test`;
    const first = await inviteStaff(ownerCtx, { email, fullName: "Shared User", roleId: managerRoleId });
    expect(first.temporaryPassword).toBeTruthy(); // new user, first tenant

    const regC = await registerOwnerAndTenant({ email: `staff-test-owner-c-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: "Owner C", businessName: "Business C" });
    const ownerCCtx = await buildContext(regC.tenantId, regC.userId, regC.membershipId);
    try {
      const second = await inviteStaff(ownerCCtx, { email, fullName: "Shared User", roleId: managerRoleId });
      expect(second.temporaryPassword).toBeUndefined(); // existing user, no new password issued

      const userCount = await db.query.users.findMany({ where: eq(users.email, email) });
      expect(userCount).toHaveLength(1); // one global user, two memberships (one per tenant)
    } finally {
      await ownerConn.db.delete(auditEventsPlatform).where(eq(auditEventsPlatform.tenantId, regC.tenantId));
      await db.delete(memberships).where(eq(memberships.tenantId, regC.tenantId));
      await db.delete(tenants).where(eq(tenants.id, regC.tenantId));
      await db.delete(users).where(eq(users.id, regC.userId));
      await db.delete(users).where(eq(users.email, email));
    }
  });

  it("rejects inviting the same person to the same tenant twice", async () => {
    const email = `dup-staff-${randomUUID()}@example.test`;
    await inviteStaff(ownerCtx, { email, fullName: "Dup Staff", roleId: managerRoleId });
    await expect(inviteStaff(ownerCtx, { email, fullName: "Dup Staff", roleId: managerRoleId })).rejects.toMatchObject({ code: "DUPLICATE_RESOURCE" });
  });

  it("[IDOR] rejects a roleId belonging to ANOTHER tenant's custom role", async () => {
    await expect(inviteStaff(ownerCtx, { email: `idor-${randomUUID()}@example.test`, fullName: "IDOR Test", roleId: tenantBCustomRoleId })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("listStaff returns the OWNER with isOwner=true and invited staff with isOwner=false", async () => {
    const staff = await listStaff(ownerCtx);
    const owner = staff.find((s) => s.userId === ownerUserId);
    expect(owner?.isOwner).toBe(true);
    expect(staff.some((s) => s.isOwner === false)).toBe(true);
  });
});

describe("Owner-Membership Invariant — INV-OWN-002/003 (05 §75a)", () => {
  it("rejects a direct role/status PATCH targeting the tenant owner's own membership", async () => {
    await expect(updateMembership(ownerCtx, ownerCtx.membershipId, { status: "SUSPENDED" })).rejects.toMatchObject({ code: "OWNER_TRANSFER_REQUIRED" });
  });

  it("allows a normal role/status PATCH on a NON-owner membership", async () => {
    const invited = await inviteStaff(ownerCtx, { email: `patchable-${randomUUID()}@example.test`, fullName: "Patchable Staff", roleId: managerRoleId });
    const updated = await updateMembership(ownerCtx, invited.membership.id, { status: "SUSPENDED" });
    expect(updated.status).toBe("SUSPENDED");
  });

  it("rejects transferOwnership from a non-owner actor", async () => {
    const invited = await inviteStaff(ownerCtx, { email: `nonowner-${randomUUID()}@example.test`, fullName: "Non Owner", roleId: managerRoleId });
    const staffCtx = await buildContext(tenantAId, invited.membership.userId, invited.membership.id);
    await expect(transferOwnership(staffCtx, invited.membership.id)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("rejects transferOwnership to a non-ACTIVE membership", async () => {
    const invited = await inviteStaff(ownerCtx, { email: `suspended-target-${randomUUID()}@example.test`, fullName: "Suspended Target", roleId: managerRoleId });
    await updateMembership(ownerCtx, invited.membership.id, { status: "SUSPENDED" });
    await expect(transferOwnership(ownerCtx, invited.membership.id)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("completes an ownership transfer atomically, after which the OLD owner's membership becomes patchable and the NEW owner's does not", async () => {
    const invited = await inviteStaff(ownerCtx, { email: `new-owner-${randomUUID()}@example.test`, fullName: "New Owner", roleId: managerRoleId });

    const updatedTenant = await transferOwnership(ownerCtx, invited.membership.id);
    expect(updatedTenant.ownerMembershipId).toBe(invited.membership.id);

    // Old owner's membership is now an ordinary membership — patchable.
    const oldOwnerPatched = await updateMembership(ownerCtx, ownerCtx.membershipId, { status: "SUSPENDED" });
    expect(oldOwnerPatched.status).toBe("SUSPENDED");

    // New owner's membership is now protected by INV-OWN-002.
    await expect(updateMembership(ownerCtx, invited.membership.id, { status: "SUSPENDED" })).rejects.toMatchObject({ code: "OWNER_TRANSFER_REQUIRED" });

    // Platform audit trail recorded the transfer (control-plane audit,
    // NOT core.audit_logs — see lib/platform-audit.ts's docblock).
    const auditRow = await db.query.auditEventsPlatform.findFirst({
      where: and(eq(auditEventsPlatform.tenantId, tenantAId), eq(auditEventsPlatform.action, "ownership.transferred")),
      orderBy: (a, { desc }) => [desc(a.createdAt)],
    });
    expect(auditRow).toBeTruthy();
  });
});

describe("Tenant-custom Role CRUD (06 §4.4, 11 §15)", () => {
  it("listRoles includes platform presets (OWNER/MANAGER/STAFF) for any tenant", async () => {
    const list = await listRoles(ownerCtx);
    expect(list.some((r) => r.key === "OWNER" && r.isSystemRole)).toBe(true);
    expect(list.some((r) => r.key === "MANAGER" && r.isSystemRole)).toBe(true);
  });

  it("creates a tenant-custom role with a resolved permission set", async () => {
    const role = await createRole(ownerCtx, { key: "SUPERVISOR", name: "Supervisor", permissionKeys: ["sales.view", "sales.create"] });
    expect(role.isSystemRole).toBe(false);
    expect(role.permissionKeys.sort()).toEqual(["sales.create", "sales.view"]);
  });

  it("rejects creating a role with an unknown permission key", async () => {
    await expect(createRole(ownerCtx, { key: "BAD_ROLE", name: "Bad Role", permissionKeys: ["not.a.real.permission"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects a duplicate role key within the same tenant", async () => {
    await createRole(ownerCtx, { key: "DUP_ROLE", name: "Dup Role", permissionKeys: ["sales.view"] });
    await expect(createRole(ownerCtx, { key: "DUP_ROLE", name: "Dup Role Again", permissionKeys: ["sales.view"] })).rejects.toMatchObject({ code: "DUPLICATE_RESOURCE" });
  });

  it("updates a tenant-custom role's permission set (wholesale replace)", async () => {
    const role = await createRole(ownerCtx, { key: "EVOLVING_ROLE", name: "Evolving Role", permissionKeys: ["sales.view"] });
    const updated = await updateRole(ownerCtx, role.id, { permissionKeys: ["purchase.view", "purchase.create"] });
    expect(updated.permissionKeys.sort()).toEqual(["purchase.create", "purchase.view"]);
  });

  it("[IDOR] cannot update a preset/system role (unreachable — 404, not 403)", async () => {
    const ownerPreset = await db.query.roles.findFirst({ where: and(isNull(roles.tenantId), eq(roles.key, "OWNER")) });
    await expect(updateRole(ownerCtx, ownerPreset!.id, { name: "Hacked Owner" })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("[IDOR] Tenant A cannot update Tenant B's custom role", async () => {
    await expect(updateRole(ownerCtx, tenantBCustomRoleId, { name: "Hijacked" })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});
