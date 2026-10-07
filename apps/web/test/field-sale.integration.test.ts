/**
 * Van Sales field sale (30 §4.3, Decisions VAN-012/VAN-013).
 * Real-PostgreSQL tests. The critical class here is the NON-double-
 * deduction regression (same class as Service's 15 §6): a field sale
 * must move ONLY the custody ledger and relieve 1250, never core
 * on-hand or 1200 a second time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  accounts, businessProfiles, db, items, journalEntries, journals, memberships, paymentAllocations, payments,
  receivables, repCustodyBalances, repStockAssignmentLines, repStockAssignments, repStockMovements, roles,
  rolePermissions, saleItems, sales, stockAdjustments, stockBalances, stockBatches, stockMovements, tenants, units, users,
  withTenantTransaction,
} from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createUnit } from "../lib/use-cases/catalog";
import { createItem } from "../lib/use-cases/item";
import { adjustStock, completeCustomerReturn } from "../lib/use-cases/returns";
import { inviteStaff } from "../lib/use-cases/staff";
import { issueRepStock } from "../lib/use-cases/rep-stock";
import { completeSale } from "../lib/use-cases/sale";

let tenantId: string;
let ownerCtx: TenantContext;
let branchId: string;
let warehouseId: string;
let staffRoleId: string;

async function ctxFor(userId: string, membershipId: string): Promise<TenantContext> {
  const m = await db.query.memberships.findFirst({ where: (t, { eq: e }) => e(t.id, membershipId) });
  return { requestId: randomUUID(), userId, tenantId, membershipId, roleId: m!.roleId, storageMode: "SHARED", permissions: await resolvePermissions(m!.roleId), roleKey: await resolveRoleKey(m!.roleId) };
}

async function newRep() {
  const { membership } = await inviteStaff(ownerCtx, { email: `fs-rep-${randomUUID()}@example.test`, fullName: "Field Sale Rep", roleId: staffRoleId });
  return { membership: membership!, ctx: await ctxFor(membership!.userId, membership!.id) };
}

async function stockedItem(qty: string) {
  const unit = await createUnit(ownerCtx, { name: `U-${randomUUID()}`, symbol: "pc" } as never);
  const item = await createItem(ownerCtx, { name: `FS Item ${randomUUID()}`, type: "PRODUCT", unitId: unit.id, sellingPrice: "500.00", purchasePrice: "300.00", stockTracked: true } as never);
  await adjustStock(ownerCtx, { itemId: item.id, warehouseId, quantityDelta: qty, reason: "seed" } as never, randomUUID());
  return item;
}

async function fifoStockedItem() {
  const unit = await createUnit(ownerCtx, { name: `U-${randomUUID()}`, symbol: "pc" } as never);
  const item = await createItem(ownerCtx, { name: `FIFO Item ${randomUUID()}`, type: "PRODUCT", unitId: unit.id, sellingPrice: "500.00", purchasePrice: "300.00", stockTracked: true, batchTracked: true } as never);
  const batches = await withTenantTransaction(tenantId, async (tx) => {
    const olderReceivedAt = new Date("2025-01-01T00:00:00.000Z");
    const newerReceivedAt = new Date("2025-02-01T00:00:00.000Z");
    const [older] = await tx.insert(stockBatches).values({ tenantId, itemId: item.id, batchNumber: `FIFO-OLD-${randomUUID()}`, receivedAt: olderReceivedAt, costPrice: "100.0000" }).returning();
    const [newer] = await tx.insert(stockBatches).values({ tenantId, itemId: item.id, batchNumber: `FIFO-NEW-${randomUUID()}`, receivedAt: newerReceivedAt, costPrice: "200.0000" }).returning();
    if (!older || !newer) throw new Error("Unable to create FIFO test batches");
    await tx.insert(stockBalances).values([
      { tenantId, itemId: item.id, warehouseId, batchId: older.id, quantityOnHand: "5.0000", weightedAvgCost: null },
      { tenantId, itemId: item.id, warehouseId, batchId: newer.id, quantityOnHand: "5.0000", weightedAvgCost: null },
    ]);
    await tx.insert(stockMovements).values([
      { tenantId, itemId: item.id, warehouseId, batchId: older.id, movementType: "PURCHASE", quantity: "5.0000", operationId: randomUUID() },
      { tenantId, itemId: item.id, warehouseId, batchId: newer.id, movementType: "PURCHASE", quantity: "5.0000", operationId: randomUUID() },
    ]);
    return [older, newer] as const;
  });
  return { item, batches };
}

const saleBody = (item: { id: string; sellingPrice: string }, qty: string, repAssignmentId?: string) =>
  ({ branchId, customerId: null, lines: [{ itemId: item.id, quantity: qty, unitPrice: item.sellingPrice, lineDiscount: "0", warehouseId }], orderDiscount: "0", cashReceived: String(Number(qty) * Number(item.sellingPrice)), repAssignmentId }) as never;

async function onHand(itemId: string) {
  const b = await withTenantTransaction(tenantId, (tx) => tx.query.stockBalances.findFirst({ where: (r, { eq: e, and: a }) => a(e(r.itemId, itemId), e(r.warehouseId, warehouseId)) }));
  return b?.quantityOnHand;
}
async function accountNet(code: string, saleId: string) {
  return withTenantTransaction(tenantId, async (tx) => {
    const acc = await tx.query.accounts.findFirst({ where: (a, { eq: e, and: an }) => an(e(a.tenantId, tenantId), e(a.code, code)) });
    if (!acc) return { debit: 0, credit: 0 };
    const rows = await tx.select({ d: journalEntries.debit, c: journalEntries.credit }).from(journalEntries).innerJoin(journals, eq(journals.id, journalEntries.journalId)).where(and(eq(journalEntries.accountId, acc.id), eq(journals.referenceId, saleId)));
    return { debit: rows.reduce((s, r) => s + Number(r.d ?? 0), 0), credit: rows.reduce((s, r) => s + Number(r.c ?? 0), 0) };
  });
}

beforeAll(async () => {
  const reg = await registerOwnerAndTenant({ email: `fs-owner-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: "FS Owner", businessName: "FS Test Business" });
  tenantId = reg.tenantId;
  ownerCtx = await ctxFor(reg.userId, reg.membershipId);
  branchId = (await withTenantTransaction(tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq: e }) => e(b.tenantId, tenantId) })))!.id;
  warehouseId = (await withTenantTransaction(tenantId, (tx) => tx.query.warehouses.findFirst({ where: (w, { eq: e }) => e(w.tenantId, tenantId) })))!.id;
  staffRoleId = (await db.query.roles.findFirst({ where: and(isNull(roles.tenantId), eq(roles.key, "STAFF")) }))!.id;
}, 30_000);

afterAll(async () => {
  if (!tenantId) return;
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
    await tx.delete(stockBatches).where(eq(stockBatches.tenantId, tenantId));
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
});

async function issued(qty: string, issueQty: string) {
  const item = await stockedItem(qty);
  const rep = await newRep();
  const assignment = await issueRepStock(ownerCtx, { repMembershipId: rep.membership.id, warehouseId, branchId, lines: [{ itemId: item.id, quantity: issueQty }] } as never, randomUUID());
  return { item, rep, assignment };
}

describe("field sale — NO double deduction (Decision VAN-012)", () => {
  it("moves only the custody ledger; core on-hand and core SALE movements are untouched; COGS relieves 1250 not 1200", async () => {
    const { item, rep, assignment } = await issued("50", "10");
    expect(await onHand(item.id)).toBe("40.0000"); // after issue

    const sale = await completeSale(rep.ctx, saleBody(item, "4", assignment.id), randomUUID());

    expect(await onHand(item.id)).toBe("40.0000"); // unchanged by the field sale
    const coreSales = await withTenantTransaction(tenantId, (tx) => tx.query.stockMovements.findMany({ where: (m, { eq: e, and: a }) => a(e(m.itemId, item.id), e(m.movementType, "SALE")) }));
    expect(coreSales).toHaveLength(0);

    const custody = await withTenantTransaction(tenantId, (tx) => tx.query.repCustodyBalances.findFirst({ where: (c, { eq: e, and: a }) => a(e(c.repMembershipId, rep.membership.id), e(c.itemId, item.id)) }));
    expect(custody?.quantityOnHand).toBe("6.0000");
    const repSale = await withTenantTransaction(tenantId, (tx) => tx.query.repStockMovements.findMany({ where: (m, { eq: e, and: a }) => a(e(m.assignmentId, assignment.id), e(m.movementType, "SALE")) }));
    expect(repSale).toHaveLength(1);
    expect(repSale[0]!.quantity).toBe("-4.0000");
    expect(repSale[0]!.referenceId).toBe(sale.id);

    // Accounting: cost = 4 * 300 = 1200 credited to 1250, nothing to 1200.
    expect((await accountNet("1250", sale.id)).credit).toBeCloseTo(1200);
    expect((await accountNet("1200", sale.id)).credit).toBe(0);
    expect((await accountNet("5000", sale.id)).debit).toBeCloseTo(1200);
  });

  it("ordinary sale (no repAssignmentId) is unchanged: core movement + 1200", async () => {
    const item = await stockedItem("20");
    const sale = await completeSale(ownerCtx, saleBody(item, "2"), randomUUID());
    expect(await onHand(item.id)).toBe("18.0000");
    expect((await accountNet("1200", sale.id)).credit).toBeCloseTo(600);
    expect((await accountNet("1250", sale.id)).credit).toBe(0);
  });

  it("allocates oldest batch first, splits the sale line, and posts batch-specific COGS", async () => {
    const { item, batches } = await fifoStockedItem();
    const input = {
      ...(saleBody(item, "6") as object),
      lines: [{ itemId: item.id, quantity: "6", unitPrice: item.sellingPrice, lineDiscount: "13.33", warehouseId }],
      cashReceived: "2986.67",
    } as never;
    const sale = await completeSale(ownerCtx, input, randomUUID());

    const soldLines = await withTenantTransaction(tenantId, (tx) => tx.query.saleItems.findMany({ where: (line, { eq: e }) => e(line.saleId, sale.id) }));
    expect(soldLines).toHaveLength(2);
    expect(soldLines.map((line) => [line.batchId, line.quantity])).toEqual([
      [batches[0].id, "5.0000"],
      [batches[1].id, "1.0000"],
    ]);
    expect(soldLines.reduce((sum, line) => sum + Number(line.lineDiscount), 0)).toBeCloseTo(13.33);
    expect(soldLines.reduce((sum, line) => sum + Number(line.lineTotal), 0)).toBeCloseTo(2986.67);

    const balances = await withTenantTransaction(tenantId, (tx) => tx.query.stockBalances.findMany({ where: (balance, { eq: e }) => e(balance.itemId, item.id) }));
    expect(balances.find((balance) => balance.batchId === batches[0].id)?.quantityOnHand).toBe("0.0000");
    expect(balances.find((balance) => balance.batchId === batches[1].id)?.quantityOnHand).toBe("4.0000");
    expect((await accountNet("5000", sale.id)).debit).toBeCloseTo(700);
    expect((await accountNet("1200", sale.id)).credit).toBeCloseTo(700);
  });

  it("rejects duplicate lines whose combined quantity exceeds available stock and rolls back", async () => {
    const item = await stockedItem("5");
    const operationId = randomUUID();
    const line = { itemId: item.id, quantity: "3", unitPrice: item.sellingPrice, lineDiscount: "0", warehouseId };
    const input = {
      ...(saleBody(item, "3") as object),
      lines: [line, line],
      cashReceived: String(Number(item.sellingPrice) * 6),
    } as never;

    await expect(completeSale(ownerCtx, input, operationId)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    expect(await onHand(item.id)).toBe("5.0000");
    const persistedSale = await withTenantTransaction(tenantId, (tx) => tx.query.sales.findFirst({ where: (sale, { eq: equals }) => equals(sale.operationId, operationId) }));
    expect(persistedSale).toBeUndefined();
    const saleMovements = await withTenantTransaction(tenantId, (tx) => tx.query.stockMovements.findMany({ where: (movement, { eq: equals, and: both }) => both(equals(movement.itemId, item.id), equals(movement.movementType, "SALE")) }));
    expect(saleMovements).toHaveLength(0);
  });

  it("allows exactly one concurrent sale against the last unit", async () => {
    const item = await stockedItem("1");
    const operationIds = [randomUUID(), randomUUID()];
    const attempts = await Promise.allSettled([
      completeSale(ownerCtx, saleBody(item, "1"), operationIds[0]!),
      completeSale(ownerCtx, saleBody(item, "1"), operationIds[1]!),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await onHand(item.id)).toBe("0.0000");
    const [persistedSales, saleMovements] = await withTenantTransaction(tenantId, async (tx) => Promise.all([
      tx.query.sales.findMany({ where: (sale, { and: both, eq: equals, inArray: oneOf }) => both(equals(sale.tenantId, tenantId), oneOf(sale.operationId, operationIds)) }),
      tx.query.stockMovements.findMany({ where: (movement, { eq: equals, and: both }) => both(equals(movement.itemId, item.id), equals(movement.movementType, "SALE")) }),
    ]));
    expect(persistedSales).toHaveLength(1);
    expect(saleMovements).toHaveLength(1);
  });
});

describe("field sale — custody availability (hook 4.5b)", () => {
  it("rejects selling more than carried, even though the warehouse still has stock", async () => {
    const { item, rep, assignment } = await issued("100", "3"); // warehouse keeps 97
    await expect(completeSale(rep.ctx, saleBody(item, "5", assignment.id), randomUUID())).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    const custody = await withTenantTransaction(tenantId, (tx) => tx.query.repCustodyBalances.findFirst({ where: (c, { eq: e, and: a }) => a(e(c.repMembershipId, rep.membership.id), e(c.itemId, item.id)) }));
    expect(custody?.quantityOnHand).toBe("3.0000"); // no partial effect
  });

  it("is idempotent on operationId", async () => {
    const { item, rep, assignment } = await issued("20", "10");
    const op = randomUUID();
    const a = await completeSale(rep.ctx, saleBody(item, "2", assignment.id), op);
    const b = await completeSale(rep.ctx, saleBody(item, "2", assignment.id), op);
    expect(b.id).toBe(a.id);
    const custody = await withTenantTransaction(tenantId, (tx) => tx.query.repCustodyBalances.findFirst({ where: (c, { eq: e, and: an }) => an(e(c.repMembershipId, rep.membership.id), e(c.itemId, item.id)) }));
    expect(custody?.quantityOnHand).toBe("8.0000");
  });
});

describe("field sale — repAssignmentId is verified, never trusted (Decision VAN-013)", () => {
  it("rejects another rep's assignment as not found", async () => {
    const { item, assignment } = await issued("20", "5");
    const other = await newRep();
    await expect(completeSale(other.ctx, saleBody(item, "1", assignment.id), randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
  it("rejects an unknown assignment id", async () => {
    const item = await stockedItem("5");
    const rep = await newRep();
    await expect(completeSale(rep.ctx, saleBody(item, "1", randomUUID()), randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
  it("rejects lines from a different warehouse than the assignment's", async () => {
    const { item, rep, assignment } = await issued("20", "5");
    const body = { ...(saleBody(item, "1", assignment.id) as object), lines: [{ itemId: item.id, quantity: "1", unitPrice: item.sellingPrice, lineDiscount: "0", warehouseId: randomUUID() }] } as never;
    await expect(completeSale(rep.ctx, body, randomUUID())).rejects.toBeTruthy();
  });
});

describe("customer return of a field sale is refused until the field return flow exists (30 §5.3)", () => {
  it("does not put custody-sold goods back into warehouse stock", async () => {
    const { item, rep, assignment } = await issued("20", "10");
    const customer = await db.query.customers?.findFirst?.({} as never).catch(() => undefined);
    void customer;
    const cust = await withTenantTransaction(tenantId, async (tx) => {
      const { customers } = await import("@erp/db");
      const [c] = await tx.insert(customers).values({ tenantId, name: "FS Customer", phone: `01${Math.floor(Math.random() * 1e9)}` } as never).returning();
      return c!;
    });
    const sale = await completeSale(rep.ctx, { ...(saleBody(item, "2", assignment.id) as object), customerId: cust.id } as never, randomUUID());
    const before = await onHand(item.id);
    await expect(completeCustomerReturn(ownerCtx, { saleId: sale.id, warehouseId, lines: [{ saleItemId: (await withTenantTransaction(tenantId, (tx) => tx.query.saleItems.findFirst({ where: (s, { eq: e }) => e(s.saleId, sale.id) })))!.id, quantity: "1", condition: "RESELLABLE" }], refundMode: "CASH" } as never, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await onHand(item.id)).toBe(before);
  });
});
