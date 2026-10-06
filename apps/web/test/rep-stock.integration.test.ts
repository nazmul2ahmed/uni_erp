/**
 * Van/Route Sales — `IssueRepStockUseCase` (30_MODULE_VAN_SALES.md §4.2).
 * Real-PostgreSQL integration tests, not mocks — matches this
 * codebase's own established pattern (return-condition.integration.
 * test.ts, sale-discount-policy.integration.test.ts) for anything
 * touching accounting/inventory correctness.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  businessProfiles,
  db,
  items,
  journalEntries,
  journals,
  memberships,
  repCustodyBalances,
  repStockAssignmentLines,
  repStockAssignments,
  repStockMovements,
  roles,
  rolePermissions,
  stockAdjustments,
  stockBalances,
  stockMovements,
  tenants,
  units,
  users,
  withTenantTransaction,
} from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createUnit } from "../lib/use-cases/catalog";
import { createItem } from "../lib/use-cases/item";
import { adjustStock } from "../lib/use-cases/returns";
import { inviteStaff } from "../lib/use-cases/staff";
import { createRole } from "../lib/use-cases/role";
import { issueRepStock } from "../lib/use-cases/rep-stock";

let tenantId: string;
let ownerCtx: TenantContext;
let branchId: string;
let warehouseId: string;
let staffRoleId: string;

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

async function newRep() {
  const { membership, temporaryPassword } = await inviteStaff(ownerCtx, {
    email: `rep-${randomUUID()}@example.test`,
    fullName: "Field Rep Test User",
    roleId: staffRoleId,
  });
  void temporaryPassword;
  return membership!;
}

async function newStockedItem(quantity: string) {
  const unit = await createUnit(ownerCtx, { name: `Unit-${randomUUID()}`, symbol: "pc" } as never);
  const item = await createItem(ownerCtx, {
    name: `Van Sales Test Item ${randomUUID()}`,
    type: "PRODUCT",
    unitId: unit.id,
    sellingPrice: "500.00",
    purchasePrice: "300.00",
    stockTracked: true,
  } as never);
  await adjustStock(ownerCtx, { itemId: item.id, warehouseId, quantityDelta: quantity, reason: "Test stock seed" } as never, randomUUID());
  return item;
}

beforeAll(async () => {
  const reg = await registerOwnerAndTenant({
    email: `van-sales-test-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: "Van Sales Test Owner",
    businessName: "Van Sales Test Business",
  });
  tenantId = reg.tenantId;
  ownerCtx = await buildContext(reg.userId, reg.membershipId);

  const branchRow = await withTenantTransaction(tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq: e }) => e(b.tenantId, tenantId) }));
  const warehouseRow = await withTenantTransaction(tenantId, (tx) => tx.query.warehouses.findFirst({ where: (w, { eq: e }) => e(w.tenantId, tenantId) }));
  branchId = branchRow!.id;
  warehouseId = warehouseRow!.id;

  const staffRole = await db.query.roles.findFirst({ where: and(isNull(roles.tenantId), eq(roles.key, "STAFF")) });
  staffRoleId = staffRole!.id;
}, 30_000);

afterAll(async () => {
  if (!tenantId) return;
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.delete(journalEntries).where(eq(journalEntries.tenantId, tenantId));
    await tx.delete(journals).where(eq(journals.tenantId, tenantId));
    await tx.delete(repStockMovements).where(eq(repStockMovements.tenantId, tenantId));
    await tx.delete(repCustodyBalances).where(eq(repCustodyBalances.tenantId, tenantId));
    await tx.delete(repStockAssignmentLines).where(eq(repStockAssignmentLines.tenantId, tenantId));
    await tx.delete(repStockAssignments).where(eq(repStockAssignments.tenantId, tenantId));
    await tx.delete(stockMovements).where(eq(stockMovements.tenantId, tenantId));
    await tx.delete(stockAdjustments).where(eq(stockAdjustments.tenantId, tenantId));
    await tx.delete(stockBalances).where(eq(stockBalances.tenantId, tenantId));
    await tx.delete(items).where(eq(items.tenantId, tenantId));
    await tx.delete(units).where(eq(units.tenantId, tenantId));
    // core.audit_logs deliberately NOT deleted: append-only (migrations-manual/0006 REVOKEs DELETE), same as sale-discount-policy test.
    await tx.delete(businessProfiles).where(eq(businessProfiles.tenantId, tenantId));
  });
  // control.* cleanup (no RLS). Order matters: memberships reference roles.
  const tenantMemberships = await db.query.memberships.findMany({ where: eq(memberships.tenantId, tenantId) });
  const userIds = tenantMemberships.map((m) => m.userId);
  await db.delete(memberships).where(eq(memberships.tenantId, tenantId));
  const tenantRoles = await db.query.roles.findMany({ where: eq(roles.tenantId, tenantId) });
  for (const role of tenantRoles) await db.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
  await db.delete(roles).where(eq(roles.tenantId, tenantId));
  for (const userId of userIds) await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
  await db.delete(tenants).where(eq(tenants.id, tenantId)).catch(() => undefined); // audit_logs are append-only and may pin the tenant row, same as existing tests
});

async function issueJournalEntries(assignmentId: string) {
  return withTenantTransaction(tenantId, (tx) =>
    tx
      .select({ code: journals.description, debit: journalEntries.debit, credit: journalEntries.credit })
      .from(journals)
      .innerJoin(journalEntries, eq(journalEntries.journalId, journals.id))
      .where(and(eq(journals.tenantId, tenantId), eq(journals.referenceId, assignmentId))),
  );
}

describe("IssueRepStockUseCase — happy path", () => {
  it("posts custody transfer correctly: core ledger, module ledger, custody balance, and a balanced 1250/1200 journal", async () => {
    const rep = await newRep();
    const item = await newStockedItem("50");

    const assignment = await issueRepStock(ownerCtx, { repMembershipId: rep.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: "10" }] } as never, randomUUID());

    expect(assignment.status).toBe("ISSUED");

    const line = await withTenantTransaction(tenantId, (tx) => tx.query.repStockAssignmentLines.findFirst({ where: (l, { eq: e }) => e(l.assignmentId, assignment.id) }));
    expect(line?.quantityIssued).toBe("10.0000");

    // core.stock_balances — warehouse on-hand decremented (50 - 10 = 40).
    const coreBalance = await withTenantTransaction(tenantId, (tx) => tx.query.stockBalances.findFirst({ where: (b, { eq: e, and: a }) => a(e(b.itemId, item.id), e(b.warehouseId, warehouseId)) }));
    expect(coreBalance?.quantityOnHand).toBe("40.0000");

    // core.stock_movements — REP_ISSUE, negative, referencing the assignment.
    const coreMovement = await withTenantTransaction(tenantId, (tx) => tx.query.stockMovements.findFirst({ where: (m, { eq: e, and: a }) => a(e(m.itemId, item.id), e(m.movementType, "REP_ISSUE")) }));
    expect(coreMovement?.quantity).toBe("-10.0000");
    expect(coreMovement?.referenceId).toBe(assignment.id);

    // modules.rep_stock_movements — ISSUE, positive custody.
    const repMovement = await withTenantTransaction(tenantId, (tx) => tx.query.repStockMovements.findFirst({ where: (m, { eq: e, and: a }) => a(e(m.assignmentId, assignment.id), e(m.movementType, "ISSUE")) }));
    expect(repMovement?.quantity).toBe("10.0000");

    // modules.rep_custody_balances — SEPARATE ledger from core, per Decision VAN-001.
    const custody = await withTenantTransaction(tenantId, (tx) => tx.query.repCustodyBalances.findFirst({ where: (c, { eq: e, and: a }) => a(e(c.repMembershipId, rep.id), e(c.itemId, item.id)) }));
    expect(custody?.quantityOnHand).toBe("10.0000");

    // Accounting — Dr 1250 / Cr 1200 at cost (10 units * 300 cost = 3000).
    const entries = await issueJournalEntries(assignment.id);
    expect(entries).toHaveLength(2);
    const totalDebit = entries.reduce((sum, row) => sum + Number(row.debit ?? 0), 0);
    const totalCredit = entries.reduce((sum, row) => sum + Number(row.credit ?? 0), 0);
    expect(totalDebit).toBeCloseTo(3000);
    expect(totalDebit).toBe(totalCredit); // 08 §11 INV-ACC-001
  });

  it("is idempotent: replaying the same operationId returns the same assignment, posts nothing twice", async () => {
    const rep = await newRep();
    const item = await newStockedItem("20");
    const operationId = randomUUID();

    const first = await issueRepStock(ownerCtx, { repMembershipId: rep.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: "5" }] } as never, operationId);
    const second = await issueRepStock(ownerCtx, { repMembershipId: rep.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: "5" }] } as never, operationId);

    expect(second.id).toBe(first.id);
    const movements = await withTenantTransaction(tenantId, (tx) => tx.query.stockMovements.findMany({ where: (m, { eq: e, and: a }) => a(e(m.itemId, item.id), e(m.movementType, "REP_ISSUE")) }));
    expect(movements).toHaveLength(1); // not double-posted (excludes the seeding ADJUSTMENT_IN from newStockedItem)
  });
});

describe("IssueRepStockUseCase — VAN-009 (one active assignment per rep)", () => {
  it("rejects a second issuance while the first is still ISSUED", async () => {
    const rep = await newRep();
    const item = await newStockedItem("20");
    await issueRepStock(ownerCtx, { repMembershipId: rep.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: "1" }] } as never, randomUUID());

    await expect(issueRepStock(ownerCtx, { repMembershipId: rep.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: "1" }] } as never, randomUUID())).rejects.toMatchObject({ code: "ASSIGNMENT_ALREADY_ACTIVE" });
  });
});

describe("IssueRepStockUseCase — VAN-008 (overdue assignment)", () => {
  it("reports ASSIGNMENT_OVERDUE (a more specific code than ASSIGNMENT_ALREADY_ACTIVE) once expectedReturnAt has passed", async () => {
    const rep = await newRep();
    const item = await newStockedItem("20");
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await issueRepStock(ownerCtx, { repMembershipId: rep.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: "1" }], expectedReturnAt: pastDate } as never, randomUUID());

    await expect(issueRepStock(ownerCtx, { repMembershipId: rep.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: "1" }] } as never, randomUUID())).rejects.toMatchObject({ code: "ASSIGNMENT_OVERDUE" });
  });
});

describe("IssueRepStockUseCase — step 2 (rep permission gate)", () => {
  it("rejects when the rep's role lacks sales.create", async () => {
    const noSalesRole = await createRole(ownerCtx, { key: `NO_SALES_${randomUUID().slice(0, 8)}`, name: "No Sales Role", permissionKeys: ["inventory.view"] } as never);
    const { membership } = await inviteStaff(ownerCtx, { email: `no-sales-rep-${randomUUID()}@example.test`, fullName: "No Sales Rep", roleId: noSalesRole.id });
    const item = await newStockedItem("20");

    await expect(issueRepStock(ownerCtx, { repMembershipId: membership!.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: "1" }] } as never, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("IssueRepStockUseCase — stock availability", () => {
  it("rejects when requested quantity exceeds available (allowNegativeStock=false, the item default)", async () => {
    const rep = await newRep();
    const item = await newStockedItem("3");

    await expect(issueRepStock(ownerCtx, { repMembershipId: rep.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: "10" }] } as never, randomUUID())).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    // Confirm no partial effect: on-hand balance unchanged, no assignment created.
    const balance = await withTenantTransaction(tenantId, (tx) => tx.query.stockBalances.findFirst({ where: (b, { eq: e, and: a }) => a(e(b.itemId, item.id), e(b.warehouseId, warehouseId)) }));
    expect(balance?.quantityOnHand).toBe("3.0000");
  });
});
