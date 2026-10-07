/**
 * Core Return Domain — `condition` Extension (Decision VAN-003).
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §12 (amended),
 * 30_MODULE_VAN_SALES.md §5.2.
 *
 * Verifies: (a) every EXISTING return behavior is byte-for-byte
 * unchanged when `condition` is omitted (RESELLABLE default) — the
 * "extension-point isolation" regression class already used
 * throughout this series (19 §12, 20 §10); (b) the NEW UNSELLABLE
 * path correctly nets stock to zero and posts an additional write-off
 * journal, while leaving the revenue-reversal journal identical.
 */
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
  withTenantTransaction,
} from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createUnit } from "../lib/use-cases/catalog";
import { createCustomer } from "../lib/use-cases/customer";
import { createItem } from "../lib/use-cases/item";
import { completeSale } from "../lib/use-cases/sale";
import { adjustStock, completeCustomerReturn } from "../lib/use-cases/returns";

let tenantId: string;
let ownerCtx: TenantContext;
let branchId: string;
let warehouseId: string;
let customerId: string;
let itemId: string;
let sellingPrice: string;

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

async function newStockedItem(quantity: string) {
  const unit = await createUnit(ownerCtx, { name: `Unit-${randomUUID()}`, symbol: "pc" } as never);
  const item = await createItem(ownerCtx, {
    name: `Return Test Item ${randomUUID()}`,
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
    email: `return-condition-test-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: "Return Condition Test Owner",
    businessName: "Return Condition Test Business",
  });
  tenantId = reg.tenantId;
  ownerCtx = await buildContext(reg.userId, reg.membershipId);

  const branchRow = await withTenantTransaction(tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq: e }) => e(b.tenantId, tenantId) }));
  const warehouseRow = await withTenantTransaction(tenantId, (tx) => tx.query.warehouses.findFirst({ where: (w, { eq: e }) => e(w.tenantId, tenantId) }));
  branchId = branchRow!.id;
  warehouseId = warehouseRow!.id;

  const customer = await createCustomer(ownerCtx, { type: "INDIVIDUAL", name: "Return Test Customer" } as never);
  customerId = customer.id;
}, 30_000);

afterAll(async () => {
  if (!tenantId) return;
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.delete(journalEntries).where(eq(journalEntries.tenantId, tenantId));
    await tx.delete(journals).where(eq(journals.tenantId, tenantId));
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.tenantId, tenantId));
    await tx.delete(payments).where(eq(payments.tenantId, tenantId));
    await tx.delete(receivables).where(eq(receivables.tenantId, tenantId));
    await tx.delete(returnLines).where(eq(returnLines.tenantId, tenantId));
    await tx.delete(returns).where(eq(returns.tenantId, tenantId));
    await tx.delete(stockMovements).where(eq(stockMovements.tenantId, tenantId));
    await tx.delete(stockBalances).where(eq(stockBalances.tenantId, tenantId));
    await tx.delete(stockAdjustments).where(eq(stockAdjustments.tenantId, tenantId));
    await tx.delete(saleItems).where(eq(saleItems.tenantId, tenantId));
    await tx.delete(sales).where(eq(sales.tenantId, tenantId));
    await tx.delete(items).where(eq(items.tenantId, tenantId));
    await tx.delete(units).where(eq(units.tenantId, tenantId));
    await tx.delete(customers).where(eq(customers.tenantId, tenantId));
    await tx.delete(businessProfiles).where(eq(businessProfiles.tenantId, tenantId));
  });
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

async function writeOffJournalEntries(returnId: string) {
  return withTenantTransaction(tenantId, (tx) =>
    tx
      .select({ code: journals.description, debit: journalEntries.debit, credit: journalEntries.credit })
      .from(journals)
      .innerJoin(journalEntries, eq(journalEntries.journalId, journals.id))
      .where(and(eq(journals.tenantId, tenantId), eq(journals.referenceId, returnId), eq(journals.description, "Customer return -- unsellable write-off"))),
  );
}

describe("Return condition — RESELLABLE (default, backward-compatible)", () => {
  it("restores sellable stock and posts no write-off journal, exactly as before this extension", async () => {
    const item = await newStockedItem("10");
    const sale = await completeSale(ownerCtx, { customerId, branchId, lines: [{ itemId: item.id, quantity: "2", unitPrice: item.sellingPrice, warehouseId, lineDiscount: "0" }], orderDiscount: "0", cashReceived: "1000.00" } as never, randomUUID());
    const saleLine = await withTenantTransaction(tenantId, (tx) => tx.query.saleItems.findFirst({ where: (si, { eq: e }) => e(si.saleId, sale.id) }));

    const ret = await completeCustomerReturn(ownerCtx, { saleId: sale.id, warehouseId, lines: [{ sourceLineId: saleLine!.id, quantity: "1" }] } as never, randomUUID());

    const balance = await withTenantTransaction(tenantId, (tx) => tx.query.stockBalances.findFirst({ where: (b, { eq: e, and: a }) => a(e(b.itemId, item.id), e(b.warehouseId, warehouseId)) }));
    expect(balance?.quantityOnHand).toBe("9.0000"); // 10 - 2 sold + 1 returned = 9
    expect(await writeOffJournalEntries(ret.id)).toHaveLength(0);
  });
});

describe("Return condition — UNSELLABLE (Decision VAN-003, new)", () => {
  it("nets stock to zero effect and posts an additional write-off journal, without changing the revenue-reversal journal", async () => {
    const item = await newStockedItem("10");
    const sale = await completeSale(ownerCtx, { customerId, branchId, lines: [{ itemId: item.id, quantity: "2", unitPrice: item.sellingPrice, warehouseId, lineDiscount: "0" }], orderDiscount: "0", cashReceived: "1000.00" } as never, randomUUID());
    const saleLine = await withTenantTransaction(tenantId, (tx) => tx.query.saleItems.findFirst({ where: (si, { eq: e }) => e(si.saleId, sale.id) }));

    const ret = await completeCustomerReturn(ownerCtx, { saleId: sale.id, warehouseId, lines: [{ sourceLineId: saleLine!.id, quantity: "1", condition: "UNSELLABLE" }] } as never, randomUUID());

    const balance = await withTenantTransaction(tenantId, (tx) => tx.query.stockBalances.findFirst({ where: (b, { eq: e, and: a }) => a(e(b.itemId, item.id), e(b.warehouseId, warehouseId)) }));
    // 10 - 2 sold = 8; +1 reinstated -1 written off = net 8, NOT 9.
    expect(balance?.quantityOnHand).toBe("8.0000");

    const writeOff = await writeOffJournalEntries(ret.id);
    expect(writeOff).toHaveLength(2); // Dr 5500, Cr 1200
    const totalDebit = writeOff.reduce((sum, row) => sum + Number(row.debit ?? 0), 0);
    const totalCredit = writeOff.reduce((sum, row) => sum + Number(row.credit ?? 0), 0);
    expect(totalDebit).toBeCloseTo(300); // 1 unit at cost 300
    expect(totalDebit).toBe(totalCredit); // balanced journal (08 §11 INV-ACC-001)

    const storedLine = await withTenantTransaction(tenantId, (tx) => tx.query.returnLines.findFirst({ where: (rl, { eq: e }) => e(rl.returnId, ret.id) }));
    expect(storedLine?.condition).toBe("UNSELLABLE");
  });

  it("mixed RESELLABLE + UNSELLABLE lines in one return post correctly, independently", async () => {
    const item = await newStockedItem("10");
    const sale = await completeSale(
      ownerCtx,
      { customerId, branchId, lines: [{ itemId: item.id, quantity: "4", unitPrice: item.sellingPrice, warehouseId, lineDiscount: "0" }], orderDiscount: "0", cashReceived: "2000.00" } as never,
      randomUUID(),
    );
    const saleLine = await withTenantTransaction(tenantId, (tx) => tx.query.saleItems.findFirst({ where: (si, { eq: e }) => e(si.saleId, sale.id) }));

    // Two separate return calls, one per condition -- the use case
    // validates cumulative returned qty against the SAME source line
    // across calls (07 §12.2), so this also exercises that guard.
    const goodReturn = await completeCustomerReturn(ownerCtx, { saleId: sale.id, warehouseId, lines: [{ sourceLineId: saleLine!.id, quantity: "1", condition: "RESELLABLE" }] } as never, randomUUID());
    const badReturn = await completeCustomerReturn(ownerCtx, { saleId: sale.id, warehouseId, lines: [{ sourceLineId: saleLine!.id, quantity: "1", condition: "UNSELLABLE" }] } as never, randomUUID());

    expect(await writeOffJournalEntries(goodReturn.id)).toHaveLength(0);
    expect(await writeOffJournalEntries(badReturn.id)).toHaveLength(2);

    const balance = await withTenantTransaction(tenantId, (tx) => tx.query.stockBalances.findFirst({ where: (b, { eq: e, and: a }) => a(e(b.itemId, item.id), e(b.warehouseId, warehouseId)) }));
    // 10 - 4 sold + 1 good return = 7 (the unsellable return nets to zero)
    expect(balance?.quantityOnHand).toBe("7.0000");
  });
});

describe("Customer return settlement — original paid/due ratio (08 §5.5)", () => {
  it("splits partial refunds cumulatively and assigns rounding remainders", async () => {
    const item = await newStockedItem("5");
    const sale = await completeSale(
      ownerCtx,
      {
        customerId,
        branchId,
        lines: [{ itemId: item.id, quantity: "3", unitPrice: item.sellingPrice, warehouseId, lineDiscount: "0" }],
        orderDiscount: "0",
        cashReceived: "500",
      } as never,
      randomUUID(),
    );
    const saleLine = await withTenantTransaction(tenantId, (tx) =>
      tx.query.saleItems.findFirst({ where: (line, { eq: equals }) => equals(line.saleId, sale.id) }),
    );
    if (!saleLine) throw new Error("Expected a sale line for proportional-return test");

    const returnRows: Array<Awaited<ReturnType<typeof completeCustomerReturn>>> = [];
    for (let index = 0; index < 3; index += 1) {
      returnRows.push(await completeCustomerReturn(
        ownerCtx,
        { saleId: sale.id, warehouseId, lines: [{ sourceLineId: saleLine.id, quantity: "1" }] } as never,
        randomUUID(),
      ));
    }

    const [receivable, journalLines] = await Promise.all([
      withTenantTransaction(tenantId, (tx) =>
        tx.query.receivables.findFirst({ where: (row, { eq: equals }) => equals(row.saleId, sale.id) }),
      ),
      withTenantTransaction(tenantId, (tx) =>
        tx.select({
          referenceId: journals.referenceId,
          code: accounts.code,
          debit: journalEntries.debit,
          credit: journalEntries.credit,
        })
          .from(journalEntries)
          .innerJoin(journals, eq(journals.id, journalEntries.journalId))
          .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
          .where(and(
            eq(journals.tenantId, tenantId),
            eq(journals.referenceType, "RETURN"),
            eq(journals.description, "Customer return -- revenue reversal"),
          )),
      ),
    ]);

    expect(returnRows.map((row) => row.cashRefundAmount)).toEqual(["166.6667", "166.6666", "166.6667"]);
    expect(returnRows.map((row) => row.receivableReductionAmount)).toEqual(["333.3333", "333.3334", "333.3333"]);
    expect(receivable).toMatchObject({ amount: "500.0000", paidAmount: "500.0000", balance: "0.0000", status: "SETTLED" });

    const testJournalLines = journalLines.filter((line) => returnRows.some((row) => row.id === line.referenceId));
    expect(testJournalLines.filter((line) => line.code === "1000").map((line) => line.credit))
      .toEqual(["166.6667", "166.6666", "166.6667"]);
    expect(testJournalLines.filter((line) => line.code === "1100").map((line) => line.credit))
      .toEqual(["333.3333", "333.3334", "333.3333"]);
    for (const row of returnRows) {
      const lines = testJournalLines.filter((line) => line.referenceId === row.id);
      expect(lines.reduce((sum, line) => sum + Number(line.debit), 0))
        .toBeCloseTo(lines.reduce((sum, line) => sum + Number(line.credit), 0), 4);
    }
  });
});
