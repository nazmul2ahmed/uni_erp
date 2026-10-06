/**
 * Van Sales Flow 1 -- RecordCustodyWriteOffUseCase (30 §5.1/§7.3, Decisions VAN-014/015/016).
 * Real-PostgreSQL tests. Critical classes: (a) custody-only effect (core stock untouched, no
 * revenue journal), (b) 1250 nets to ZERO per assignment even after the warehouse WAC moves
 * (VAN-014), (c) idempotent replay, (d) authorization + tenant isolation fail closed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  accounts, auditLogs, businessProfiles, db, items, journalEntries, journals, memberships, paymentAllocations, payments,
  receivables, repCustodyBalances, repStockAssignmentLines, repStockAssignments, repStockMovements, roles,
  rolePermissions, saleItems, sales, stockAdjustments, stockBalances, stockMovements, tenants, units, users,
  withTenantTransaction,
} from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createUnit } from "../lib/use-cases/catalog";
import { createItem } from "../lib/use-cases/item";
import { adjustStock } from "../lib/use-cases/returns";
import { inviteStaff } from "../lib/use-cases/staff";
import { issueRepStock, recordCustodyWriteOff } from "../lib/use-cases/rep-stock";
import { completeSale } from "../lib/use-cases/sale";

type Fixture = { tenantId: string; ownerCtx: TenantContext; branchId: string; warehouseId: string };
let A: Fixture;
let B: Fixture;
let staffRoleId: string;
let managerRoleId: string;
const tenantIds: string[] = [];

async function ctxFor(tenantId: string, userId: string, membershipId: string): Promise<TenantContext> {
  const m = await db.query.memberships.findFirst({ where: (t, { eq: e }) => e(t.id, membershipId) });
  return { requestId: randomUUID(), userId, tenantId, membershipId, roleId: m!.roleId, storageMode: "SHARED", permissions: await resolvePermissions(m!.roleId), roleKey: await resolveRoleKey(m!.roleId) };
}

async function setupTenant(label: string): Promise<Fixture> {
  const reg = await registerOwnerAndTenant({ email: `wo-${label}-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: `WO ${label}`, businessName: `WO Test ${label}` });
  tenantIds.push(reg.tenantId);
  const branchId = (await withTenantTransaction(reg.tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq: e }) => e(b.tenantId, reg.tenantId) })))!.id;
  const warehouseId = (await withTenantTransaction(reg.tenantId, (tx) => tx.query.warehouses.findFirst({ where: (w, { eq: e }) => e(w.tenantId, reg.tenantId) })))!.id;
  return { tenantId: reg.tenantId, ownerCtx: await ctxFor(reg.tenantId, reg.userId, reg.membershipId), branchId, warehouseId };
}

async function newStaff(f: Fixture, roleId: string) {
  const { membership } = await inviteStaff(f.ownerCtx, { email: `wo-staff-${randomUUID()}@example.test`, fullName: "WO Staff", roleId });
  return { membership: membership!, ctx: await ctxFor(f.tenantId, membership!.userId, membership!.id) };
}

async function stockedItem(f: Fixture, qty: string) {
  const unit = await createUnit(f.ownerCtx, { name: `U-${randomUUID()}`, symbol: "pc" } as never);
  const item = await createItem(f.ownerCtx, { name: `WO Item ${randomUUID()}`, type: "PRODUCT", unitId: unit.id, sellingPrice: "500.00", purchasePrice: "300.00", stockTracked: true } as never);
  await adjustStock(f.ownerCtx, { itemId: item.id, warehouseId: f.warehouseId, quantityDelta: qty, reason: "seed" } as never, randomUUID());
  return item;
}

async function issued(f: Fixture, qty: string, issueQty: string) {
  const item = await stockedItem(f, qty);
  const rep = await newStaff(f, staffRoleId);
  const assignment = await issueRepStock(f.ownerCtx, { repMembershipId: rep.membership.id, warehouseId: f.warehouseId, branchId: f.branchId, lines: [{ itemId: item.id, quantity: issueQty }] } as never, randomUUID());
  return { item, rep, assignment };
}

const writeOffBody = (assignmentId: string, itemId: string, quantity: string, reason: "DAMAGED" | "EXPIRED" = "DAMAGED") => ({ repStockAssignmentId: assignmentId, lines: [{ itemId, quantity, reason }] }) as never;

async function custodyOnHand(f: Fixture, repMembershipId: string, itemId: string) {
  const row = await withTenantTransaction(f.tenantId, (tx) => tx.query.repCustodyBalances.findFirst({ where: (c, { eq: e, and: a }) => a(e(c.repMembershipId, repMembershipId), e(c.itemId, itemId)) }));
  return row?.quantityOnHand;
}
async function coreOnHand(f: Fixture, itemId: string) {
  const b = await withTenantTransaction(f.tenantId, (tx) => tx.query.stockBalances.findFirst({ where: (r, { eq: e, and: a }) => a(e(r.itemId, itemId), e(r.warehouseId, f.warehouseId)) }));
  return b?.quantityOnHand;
}
/** Sum of debit/credit on one account across journals whose referenceId is in refIds. */
async function net(f: Fixture, code: string, refIds: string[]) {
  return withTenantTransaction(f.tenantId, async (tx) => {
    const acc = await tx.query.accounts.findFirst({ where: (a, { eq: e, and: an }) => an(e(a.tenantId, f.tenantId), e(a.code, code)) });
    if (!acc) return { debit: 0, credit: 0 };
    const rows = await tx.select({ d: journalEntries.debit, c: journalEntries.credit }).from(journalEntries).innerJoin(journals, eq(journals.id, journalEntries.journalId)).where(and(eq(journalEntries.accountId, acc.id), inArray(journals.referenceId, refIds)));
    return { debit: rows.reduce((s, r) => s + Number(r.d ?? 0), 0), credit: rows.reduce((s, r) => s + Number(r.c ?? 0), 0) };
  });
}
async function journalCount(f: Fixture, refId: string) {
  return withTenantTransaction(f.tenantId, async (tx) => (await tx.select().from(journals).where(and(eq(journals.tenantId, f.tenantId), eq(journals.referenceId, refId)))).length);
}

beforeAll(async () => {
  A = await setupTenant("A");
  B = await setupTenant("B");
  staffRoleId = (await db.query.roles.findFirst({ where: and(isNull(roles.tenantId), eq(roles.key, "STAFF")) }))!.id;
  managerRoleId = (await db.query.roles.findFirst({ where: and(isNull(roles.tenantId), eq(roles.key, "MANAGER")) }))!.id;
}, 60_000);

afterAll(async () => {
  for (const tenantId of tenantIds) {
    await withTenantTransaction(tenantId, async (tx) => {
      await tx.delete(journalEntries).where(eq(journalEntries.tenantId, tenantId));
      await tx.delete(journals).where(eq(journals.tenantId, tenantId));
      await tx.delete(paymentAllocations).where(eq(paymentAllocations.tenantId, tenantId));
      await tx.delete(payments).where(eq(payments.tenantId, tenantId));
      await tx.delete(receivables).where(eq(receivables.tenantId, tenantId));
      await tx.delete(saleItems).where(eq(saleItems.tenantId, tenantId));
      await tx.delete(sales).where(eq(sales.tenantId, tenantId));
      await tx.delete(repStockMovements).where(eq(repStockMovements.tenantId, tenantId));
      await tx.delete(repCustodyBalances).where(eq(repCustodyBalances.tenantId, tenantId));
      await tx.delete(repStockAssignmentLines).where(eq(repStockAssignmentLines.tenantId, tenantId));
      await tx.delete(repStockAssignments).where(eq(repStockAssignments.tenantId, tenantId));
      await tx.delete(stockMovements).where(eq(stockMovements.tenantId, tenantId));
      await tx.delete(stockAdjustments).where(eq(stockAdjustments.tenantId, tenantId));
      await tx.delete(stockBalances).where(eq(stockBalances.tenantId, tenantId));
      await tx.delete(items).where(eq(items.tenantId, tenantId));
      await tx.delete(units).where(eq(units.tenantId, tenantId));
      await tx.delete(businessProfiles).where(eq(businessProfiles.tenantId, tenantId));
      await tx.delete(accounts).where(eq(accounts.tenantId, tenantId));
    }).catch(() => undefined);
    const ms = await db.query.memberships.findMany({ where: eq(memberships.tenantId, tenantId) });
    await db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    for (const r of await db.query.roles.findMany({ where: eq(roles.tenantId, tenantId) })) await db.delete(rolePermissions).where(eq(rolePermissions.roleId, r.id));
    await db.delete(roles).where(eq(roles.tenantId, tenantId));
    for (const m of ms) await db.delete(users).where(eq(users.id, m.userId)).catch(() => undefined);
    await db.delete(tenants).where(eq(tenants.id, tenantId)).catch(() => undefined);
  }
});

describe("Flow 1 -- custody write-off effects (30 §5.1)", () => {
  it("moves ONLY the custody ledger: core stock untouched, Dr 5500 / Cr 1250 at issue cost, no revenue journal", async () => {
    const { item, rep, assignment } = await issued(A, "50", "10");
    const coreBefore = await coreOnHand(A, item.id); // 40 after issue
    const result = await recordCustodyWriteOff(A.ownerCtx, { repStockAssignmentId: assignment.id, lines: [{ itemId: item.id, quantity: "2", reason: "DAMAGED" }, { itemId: item.id, quantity: "1", reason: "EXPIRED" }] } as never, randomUUID());

    expect(result.replayed).toBe(false);
    expect(result.movements.map((m) => m.movementType).sort()).toEqual(["RETURN_DAMAGED", "RETURN_EXPIRED"]);
    expect(await custodyOnHand(A, rep.membership.id, item.id)).toBe("7.0000");
    expect(await coreOnHand(A, item.id)).toBe(coreBefore); // 30 §4.1: core.stock_balances NEVER touched
    const coreWriteoffs = await withTenantTransaction(A.tenantId, (tx) => tx.query.stockMovements.findMany({ where: (m, { eq: e, and: a }) => a(e(m.itemId, item.id), e(m.referenceId, assignment.id), e(m.movementType, "LOSS")) }));
    expect(coreWriteoffs).toHaveLength(0);

    // 3 units * 300 = 900: Dr 5500, Cr 1250 (issue itself debited 1250 3000 / credited 1200 3000).
    expect((await net(A, "5500", [assignment.id])).debit).toBeCloseTo(900);
    expect((await net(A, "1250", [assignment.id])).credit).toBeCloseTo(900);
    expect((await net(A, "1250", [assignment.id])).debit).toBeCloseTo(3000);
    // No revenue / cash / receivable effect (30 §10 "Flow 1 vs Flow 2").
    for (const code of ["4000", "1000", "1100"]) {
      const n = await net(A, code, [assignment.id]);
      expect(n.debit + n.credit).toBe(0);
    }
    const audit = await withTenantTransaction(A.tenantId, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.tenantId, A.tenantId), eq(auditLogs.action, "rep_stock.custody_writeoff"), eq(auditLogs.entityId, assignment.id))));
    expect(audit).toHaveLength(1);
  });

  it("rejects writing off more than the rep holds, changing nothing", async () => {
    const { item, rep, assignment } = await issued(A, "20", "5");
    await expect(recordCustodyWriteOff(A.ownerCtx, writeOffBody(assignment.id, item.id, "5.0001"), randomUUID())).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    // Second line exceeds after the first line consumed custody -> whole call rolls back atomically.
    await expect(recordCustodyWriteOff(A.ownerCtx, { repStockAssignmentId: assignment.id, lines: [{ itemId: item.id, quantity: "3", reason: "DAMAGED" }, { itemId: item.id, quantity: "3", reason: "DAMAGED" }] } as never, randomUUID())).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await custodyOnHand(A, rep.membership.id, item.id)).toBe("5.0000");
    expect((await net(A, "5500", [assignment.id])).debit).toBe(0);
  });

  it("is idempotent: replaying the same operationId posts nothing twice", async () => {
    const { item, rep, assignment } = await issued(A, "20", "10");
    const op = randomUUID();
    const first = await recordCustodyWriteOff(A.ownerCtx, writeOffBody(assignment.id, item.id, "4"), op);
    const second = await recordCustodyWriteOff(A.ownerCtx, writeOffBody(assignment.id, item.id, "4"), op);
    expect(second.replayed).toBe(true);
    expect(second.movements.map((m) => m.id)).toEqual(first.movements.map((m) => m.id));
    expect(await custodyOnHand(A, rep.membership.id, item.id)).toBe("6.0000");
    expect((await net(A, "5500", [assignment.id])).debit).toBeCloseTo(1200);
    expect(await journalCount(A, assignment.id)).toBe(2); // issue + ONE write-off
  });

  it("rejects reusing an Idempotency-Key against a different assignment", async () => {
    const one = await issued(A, "20", "5");
    const two = await issued(A, "20", "5");
    const op = randomUUID();
    await recordCustodyWriteOff(A.ownerCtx, writeOffBody(one.assignment.id, one.item.id, "1"), op);
    await expect(recordCustodyWriteOff(A.ownerCtx, writeOffBody(two.assignment.id, two.item.id, "1"), op)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await custodyOnHand(A, two.rep.membership.id, two.item.id)).toBe("5.0000");
  });

  it("only an ISSUED assignment can be written off against (VAN-016)", async () => {
    const { item, assignment } = await issued(A, "20", "5");
    await withTenantTransaction(A.tenantId, (tx) => tx.update(repStockAssignments).set({ status: "RECONCILED" }).where(eq(repStockAssignments.id, assignment.id)));
    await expect(recordCustodyWriteOff(A.ownerCtx, writeOffBody(assignment.id, item.id, "1"), randomUUID())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects an item that is not part of the assignment", async () => {
    const { assignment } = await issued(A, "20", "5");
    const other = await stockedItem(A, "5");
    await expect(recordCustodyWriteOff(A.ownerCtx, writeOffBody(assignment.id, other.id, "1"), randomUUID())).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });
});

describe("Flow 1 -- authorization and tenant isolation fail closed (VAN-015)", () => {
  it("the rep cannot write off their own custody; a MANAGER can", async () => {
    const { item, rep, assignment } = await issued(A, "20", "5");
    expect(rep.ctx.permissions).not.toContain("vansales.writeoff");
    await expect(recordCustodyWriteOff(rep.ctx, writeOffBody(assignment.id, item.id, "1"), randomUUID())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await custodyOnHand(A, rep.membership.id, item.id)).toBe("5.0000");

    const manager = await newStaff(A, managerRoleId);
    expect(manager.ctx.permissions).toContain("vansales.writeoff");
    await recordCustodyWriteOff(manager.ctx, writeOffBody(assignment.id, item.id, "1"), randomUUID());
    expect(await custodyOnHand(A, rep.membership.id, item.id)).toBe("4.0000");
  });

  it("Tenant B cannot write off Tenant A's assignment (404, nothing changes)", async () => {
    const { item, rep, assignment } = await issued(A, "20", "5");
    await expect(recordCustodyWriteOff(B.ownerCtx, writeOffBody(assignment.id, item.id, "1"), randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(await custodyOnHand(A, rep.membership.id, item.id)).toBe("5.0000");
    expect((await net(A, "5500", [assignment.id])).debit).toBe(0);
  });
});

describe("Decision VAN-014 -- 1250 nets to zero per assignment despite WAC movement", () => {
  it("field-sale COGS and write-off both relieve 1250 at the ISSUE-time cost", async () => {
    const { item, rep, assignment } = await issued(A, "50", "10"); // issued at 300
    // Warehouse WAC moves AFTER issue (e.g. a later purchase at a higher cost).
    await withTenantTransaction(A.tenantId, (tx) => tx.update(stockBalances).set({ weightedAvgCost: "400.0000" }).where(and(eq(stockBalances.tenantId, A.tenantId), eq(stockBalances.itemId, item.id))));

    const sale = await completeSale(rep.ctx, { branchId: A.branchId, customerId: null, lines: [{ itemId: item.id, quantity: "4", unitPrice: item.sellingPrice, lineDiscount: "0", warehouseId: A.warehouseId }], orderDiscount: "0", cashReceived: "2000", repAssignmentId: assignment.id } as never, randomUUID());
    // COGS at the custody snapshot 300 * 4 = 1200 -- NOT today's WAC 400 * 4 = 1600.
    expect((await net(A, "5000", [sale.id])).debit).toBeCloseTo(1200);
    expect((await net(A, "1250", [sale.id])).credit).toBeCloseTo(1200);

    await recordCustodyWriteOff(A.ownerCtx, writeOffBody(assignment.id, item.id, "6"), randomUUID());
    const account = await net(A, "1250", [assignment.id, sale.id]);
    expect(account.debit).toBeCloseTo(3000); // issue
    expect(account.credit).toBeCloseTo(3000); // sale 1200 + write-off 1800
    expect(await custodyOnHand(A, rep.membership.id, item.id)).toBe("0.0000");
  });
});
