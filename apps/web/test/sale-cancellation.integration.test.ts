import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  auditLogs,
  businessProfiles,
  customers,
  db,
  items,
  journalEntries,
  journals,
  memberships,
  paymentAllocations,
  payments,
  receivables,
  returnLines,
  returns,
  saleItems,
  sales,
  stockAdjustments,
  stockBalances,
  stockMovements,
  tenants,
  units,
  users,
  withTenantTransaction,
} from "@erp/db";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { createUnit } from "../lib/use-cases/catalog";
import { createCustomer } from "../lib/use-cases/customer";
import { createItem } from "../lib/use-cases/item";
import { cancelSale, completeSale } from "../lib/use-cases/sale";
import { adjustStock, completeCustomerReturn } from "../lib/use-cases/returns";
import { recordCustomerPayment, getFinanceSummary } from "../lib/use-cases/finance";

type Fixture = {
  tenantId: string;
  userId: string;
  ctx: TenantContext;
  branchId: string;
  warehouseId: string;
  customerId: string;
};

let A: Fixture;
let B: Fixture;

async function provision(label: string): Promise<Fixture> {
  const reg = await registerOwnerAndTenant({
    email: `sale-cancel-${label}-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: `Sale Cancel ${label}`,
    businessName: `Sale Cancel ${label}`,
  });
  const membership = await db.query.memberships.findFirst({ where: eq(memberships.id, reg.membershipId) });
  if (!membership) throw new Error("Fixture setup failed: owner membership missing");
  const ctx: TenantContext = {
    requestId: randomUUID(),
    userId: reg.userId,
    tenantId: reg.tenantId,
    membershipId: reg.membershipId,
    roleId: membership.roleId,
    storageMode: "SHARED",
    permissions: await resolvePermissions(membership.roleId),
    roleKey: await resolveRoleKey(membership.roleId),
  };
  const [branch, warehouse] = await withTenantTransaction(reg.tenantId, async (tx) => Promise.all([
    tx.query.branches.findFirst({ where: (row, { eq: e }) => e(row.tenantId, reg.tenantId) }),
    tx.query.warehouses.findFirst({ where: (row, { eq: e }) => e(row.tenantId, reg.tenantId) }),
  ]));
  if (!branch || !warehouse) throw new Error("Fixture setup failed: branch or warehouse missing");
  const customer = await createCustomer(ctx, { type: "INDIVIDUAL", name: `Cancel Customer ${label}` } as never);
  return { tenantId: reg.tenantId, userId: reg.userId, ctx, branchId: branch.id, warehouseId: warehouse.id, customerId: customer.id };
}

async function cleanup(f: Fixture | undefined) {
  if (!f) return;
  await withTenantTransaction(f.tenantId, async (tx) => {
    await tx.delete(journalEntries).where(eq(journalEntries.tenantId, f.tenantId));
    await tx.delete(journals).where(eq(journals.tenantId, f.tenantId));
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.tenantId, f.tenantId));
    await tx.delete(payments).where(eq(payments.tenantId, f.tenantId));
    await tx.delete(receivables).where(eq(receivables.tenantId, f.tenantId));
    await tx.delete(returnLines).where(eq(returnLines.tenantId, f.tenantId));
    await tx.delete(returns).where(eq(returns.tenantId, f.tenantId));
    await tx.delete(stockMovements).where(eq(stockMovements.tenantId, f.tenantId));
    await tx.delete(stockBalances).where(eq(stockBalances.tenantId, f.tenantId));
    await tx.delete(stockAdjustments).where(eq(stockAdjustments.tenantId, f.tenantId));
    await tx.delete(saleItems).where(eq(saleItems.tenantId, f.tenantId));
    await tx.delete(sales).where(eq(sales.tenantId, f.tenantId));
    await tx.delete(items).where(eq(items.tenantId, f.tenantId));
    await tx.delete(units).where(eq(units.tenantId, f.tenantId));
    await tx.delete(customers).where(eq(customers.tenantId, f.tenantId));
    await tx.delete(businessProfiles).where(eq(businessProfiles.tenantId, f.tenantId));
  });
  const tenantMemberships = await db.query.memberships.findMany({ where: eq(memberships.tenantId, f.tenantId) });
  await db.delete(tenants).where(eq(tenants.id, f.tenantId));
  for (const membership of tenantMemberships) {
    await db.delete(users).where(eq(users.id, membership.userId));
  }
  await db.delete(users).where(eq(users.id, f.userId));
}

async function newStockedItem(f: Fixture) {
  const suffix = randomUUID().slice(0, 8);
  const unit = await createUnit(f.ctx, { name: `Cancel Unit ${suffix}`, symbol: `u${suffix}` } as never);
  const item = await createItem(f.ctx, {
    name: `Cancel Item ${suffix}`,
    type: "PRODUCT",
    unitId: unit.id,
    sellingPrice: "1000",
    purchasePrice: "300",
    stockTracked: true,
  } as never);
  await adjustStock(f.ctx, { itemId: item.id, warehouseId: f.warehouseId, quantityDelta: "5", reason: "Cancellation test stock" } as never, randomUUID());
  return item;
}

async function saleFor(f: Fixture, cashReceived: string) {
  const item = await newStockedItem(f);
  const sale = await completeSale(f.ctx, {
    branchId: f.branchId,
    customerId: f.customerId,
    lines: [{ itemId: item.id, quantity: "1", unitPrice: item.sellingPrice, warehouseId: f.warehouseId, lineDiscount: "0" }],
    orderDiscount: "0",
    cashReceived,
  } as never, randomUUID());
  return { item, sale };
}

async function accountBalances(f: Fixture) {
  return withTenantTransaction(f.tenantId, async (tx) => tx
    .select({ code: accounts.code, debit: journalEntries.debit, credit: journalEntries.credit })
    .from(journalEntries)
    .innerJoin(journals, eq(journals.id, journalEntries.journalId))
    .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
    .where(and(eq(journalEntries.tenantId, f.tenantId), eq(journals.tenantId, f.tenantId), eq(accounts.tenantId, f.tenantId))));
}

beforeAll(async () => {
  A = await provision("A");
  B = await provision("B");
}, 60_000);

afterAll(async () => {
  await cleanup(A);
  await cleanup(B);
});

describe("sale cancellation with paid amount refunded and remaining due reversed", () => {
  it("reverses a part-paid sale, refunds subsequent allocations by method, restores stock, and replays once", async () => {
    const before = await getFinanceSummary(A.ctx);
    const { item, sale } = await saleFor(A, "300");
    await recordCustomerPayment(A.ctx, {
      customerId: A.customerId,
      amount: "200",
      method: "BANK",
      allocations: [{ saleId: sale.id, amount: "200" }],
    } as never, randomUUID());
    const operationId = randomUUID();

    const cancelled = await cancelSale(A.ctx, sale.id, { reason: "Customer order cancelled" }, operationId);

    expect(cancelled).toMatchObject({ id: sale.id, status: "CANCELLED", cancelledReason: "Customer order cancelled" });
    expect(cancelled.cancelOperationId).toBe(operationId);
    const [state, finance, refundRows, cancelAudit] = await Promise.all([
      withTenantTransaction(A.tenantId, async (tx) => {
        const [balance] = await tx.select().from(stockBalances).where(and(eq(stockBalances.tenantId, A.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, A.warehouseId)));
        const receivable = await tx.query.receivables.findFirst({ where: and(eq(receivables.tenantId, A.tenantId), eq(receivables.saleId, sale.id)) });
        const allocations = await tx.select({
          direction: payments.direction,
          method: payments.method,
          amount: payments.amount,
        })
          .from(paymentAllocations)
          .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
          .where(and(eq(paymentAllocations.tenantId, A.tenantId), eq(paymentAllocations.allocatedToId, sale.id)));
        return { balance, receivable, allocations };
      }),
      getFinanceSummary(A.ctx),
      withTenantTransaction(A.tenantId, (tx) => tx.select({
        direction: payments.direction,
        method: payments.method,
        amount: payments.amount,
      }).from(payments).innerJoin(paymentAllocations, eq(paymentAllocations.paymentId, payments.id))
        .where(and(eq(payments.tenantId, A.tenantId), eq(paymentAllocations.allocatedToId, sale.id)))),
      withTenantTransaction(A.tenantId, (tx) => tx.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, A.tenantId), eq(auditLogs.action, "sale.cancel"), eq(auditLogs.entityId, sale.id)) })),
    ]);

    expect(state.balance?.quantityOnHand).toBe("5.0000");
    expect(state.receivable).toMatchObject({ status: "CANCELLED", balance: "0.0000", paidAmount: "500.0000" });
    expect(finance).toMatchObject({ cash: before.cash, bank: before.bank, receivables: before.receivables });
    expect(refundRows.filter((row) => row.direction === "OUT").map((row) => [row.method, row.amount]).sort()).toEqual([
      ["BANK", "200.0000"],
      ["CASH", "300.0000"],
    ]);
    expect(cancelAudit).toMatchObject({ action: "sale.cancel", reason: "Customer order cancelled" });

    const countBeforeReplay = refundRows.length;
    await expect(cancelSale(A.ctx, sale.id, { reason: "Customer order cancelled" }, operationId)).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(cancelSale(A.ctx, sale.id, { reason: "Different key" }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const countAfterReplay = await withTenantTransaction(A.tenantId, (tx) => tx
      .select({ id: payments.id })
      .from(payments)
      .innerJoin(paymentAllocations, eq(paymentAllocations.paymentId, payments.id))
      .where(and(eq(payments.tenantId, A.tenantId), eq(paymentAllocations.allocatedToId, sale.id))));
    expect(countAfterReplay).toHaveLength(countBeforeReplay);

    const entries = await accountBalances(A);
    const totals = new Map<string, { debit: number; credit: number }>();
    for (const entry of entries) {
      const current = totals.get(entry.code) ?? { debit: 0, credit: 0 };
      current.debit += Number(entry.debit);
      current.credit += Number(entry.credit);
      totals.set(entry.code, current);
    }
    expect([...totals.values()].every(({ debit, credit }) => Math.abs(debit - credit) < 0.0001)).toBe(true);
  });

  it("cancels an unpaid sale by closing the receivable without creating a refund", async () => {
    const before = await getFinanceSummary(A.ctx);
    const { item, sale } = await saleFor(A, "0");
    const cancelled = await cancelSale(A.ctx, sale.id, { reason: "Duplicate order" }, randomUUID());

    expect(cancelled.status).toBe("CANCELLED");
    const [balance, receivable, outgoingPayments, finance] = await Promise.all([
      withTenantTransaction(A.tenantId, (tx) => tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.tenantId, A.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, A.warehouseId)) })),
      withTenantTransaction(A.tenantId, (tx) => tx.query.receivables.findFirst({ where: and(eq(receivables.tenantId, A.tenantId), eq(receivables.saleId, sale.id)) })),
      withTenantTransaction(A.tenantId, (tx) => tx.select({ id: payments.id }).from(payments)
        .innerJoin(paymentAllocations, eq(paymentAllocations.paymentId, payments.id))
        .where(and(eq(payments.tenantId, A.tenantId), eq(payments.partyId, A.customerId), eq(payments.direction, "OUT"), eq(paymentAllocations.allocatedToId, sale.id)))),
      getFinanceSummary(A.ctx),
    ]);
    expect(balance?.quantityOnHand).toBe("5.0000");
    expect(receivable).toMatchObject({ status: "CANCELLED", balance: "0.0000", paidAmount: "0.0000" });
    expect(outgoingPayments).toHaveLength(0);
    expect(finance).toMatchObject({ cash: before.cash, bank: before.bank, receivables: before.receivables });
    await expect(recordCustomerPayment(A.ctx, {
      customerId: A.customerId,
      amount: "1",
      method: "CASH",
      allocations: [{ saleId: sale.id, amount: "1" }],
    } as never, randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("refunds the initial full payment and preserves balanced reversal journals", async () => {
    const before = await getFinanceSummary(A.ctx);
    const { item, sale } = await saleFor(A, "1000");
    const cancelled = await cancelSale(A.ctx, sale.id, { reason: "Mistaken sale" }, randomUUID());

    expect(cancelled.status).toBe("CANCELLED");
    const [balance, outgoing, finance] = await Promise.all([
      withTenantTransaction(A.tenantId, (tx) => tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.tenantId, A.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, A.warehouseId)) })),
      withTenantTransaction(A.tenantId, (tx) => tx.select({
        id: payments.id,
        amount: payments.amount,
        method: payments.method,
      }).from(payments)
        .innerJoin(paymentAllocations, eq(paymentAllocations.paymentId, payments.id))
        .where(and(eq(payments.tenantId, A.tenantId), eq(payments.partyId, A.customerId), eq(payments.direction, "OUT"), eq(paymentAllocations.allocatedToId, sale.id)))),
      getFinanceSummary(A.ctx),
    ]);
    expect(balance?.quantityOnHand).toBe("5.0000");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).toMatchObject({ amount: "1000.0000", method: "CASH" });
    expect(finance).toMatchObject({ cash: before.cash, bank: before.bank, receivables: before.receivables });

    const saleJournals = await withTenantTransaction(A.tenantId, (tx) => tx.query.journals.findMany({ where: and(eq(journals.tenantId, A.tenantId), eq(journals.referenceType, "SALE"), eq(journals.referenceId, sale.id)) }));
    expect(saleJournals).toHaveLength(2);
    for (const original of saleJournals) {
      const reversal = await withTenantTransaction(A.tenantId, (tx) => tx.query.journals.findFirst({ where: and(eq(journals.tenantId, A.tenantId), eq(journals.referenceType, "REVERSAL"), eq(journals.referenceId, original.id)) }));
      expect(reversal).toBeDefined();
      const lines = await withTenantTransaction(A.tenantId, (tx) => tx.select({ debit: journalEntries.debit, credit: journalEntries.credit }).from(journalEntries).where(eq(journalEntries.journalId, reversal!.id)));
      expect(lines.reduce((sum, line) => sum + Number(line.debit), 0)).toBeCloseTo(lines.reduce((sum, line) => sum + Number(line.credit), 0), 4);
    }
  });

  it("does not disclose or cancel a sale from another tenant", async () => {
    const { sale } = await saleFor(A, "0");
    await expect(cancelSale(B.ctx, sale.id, { reason: "Cross-tenant attempt" }, randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("serializes concurrent customer payments before cancellation can close the balance", async () => {
    const { sale } = await saleFor(A, "0");
    const attempts = await Promise.allSettled([
      recordCustomerPayment(A.ctx, {
        customerId: A.customerId,
        amount: "600",
        method: "CASH",
        allocations: [{ saleId: sale.id, amount: "600" }],
      } as never, randomUUID()),
      recordCustomerPayment(A.ctx, {
        customerId: A.customerId,
        amount: "600",
        method: "BANK",
        allocations: [{ saleId: sale.id, amount: "600" }],
      } as never, randomUUID()),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const persistedSale = await withTenantTransaction(A.tenantId, (tx) => tx.query.sales.findFirst({ where: and(eq(sales.tenantId, A.tenantId), eq(sales.id, sale.id)) }));
    expect(persistedSale?.paidTotal).toBe("600.0000");
    expect(persistedSale?.dueTotal).toBe("400.0000");
    await expect(cancelSale(A.ctx, sale.id, { reason: "Concurrent payment test" }, randomUUID())).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("refuses cancellation after a completed return instead of restoring the same stock twice", async () => {
    const { item, sale } = await saleFor(A, "1000");
    const line = await withTenantTransaction(A.tenantId, (tx) => tx.query.saleItems.findFirst({ where: and(eq(saleItems.tenantId, A.tenantId), eq(saleItems.saleId, sale.id)) }));
    if (!line) throw new Error("Fixture setup failed: sale line missing");
    await completeCustomerReturn(A.ctx, {
      saleId: sale.id,
      warehouseId: A.warehouseId,
      lines: [{ sourceLineId: line.id, quantity: "1" }],
    } as never, randomUUID());

    await expect(cancelSale(A.ctx, sale.id, { reason: "Do not double restore" }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const [balance, persistedSale] = await withTenantTransaction(A.tenantId, async (tx) => Promise.all([
      tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.tenantId, A.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, A.warehouseId)) }),
      tx.query.sales.findFirst({ where: and(eq(sales.tenantId, A.tenantId), eq(sales.id, sale.id)) }),
    ]));
    expect(balance?.quantityOnHand).toBe("5.0000");
    expect(persistedSale?.status).toBe("PAID");
  });
});
