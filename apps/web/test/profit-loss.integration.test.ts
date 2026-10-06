/**
 * Profit & Loss -- real-PostgreSQL reconciliation test.
 * 08_ACCOUNTING_ENGINE_SPECIFICATION.md s6.2, Decision ACC-006.
 *
 * Item: sells 500, costs 300. Known postings (owner has discount override):
 *   sale 1: 4 x 500, no discount      -> revenue 2000, COGS 1200
 *   sale 2: 2 x 500, order disc 100   -> revenue 1000, COGS  600, Discount Given 100
 *   return: 1 x 500 UNSELLABLE of sale 1 -> revenue -500, COGS -300, write-off 5500 +300
 * Expected totals: revenue 2500, COGS 1500, gross 1000, opex 400, net 600.
 *
 * Also asserts the invariants that make a P&L trustworthy: independent
 * recomputation from raw journal entries, ledger balance, date-range
 * behaviour, and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  accounts, businessProfiles, customers, db, items, journalEntries, journals, memberships, paymentAllocations, payments,
  receivables, returnLines, returns as returnsTable, roles, rolePermissions, saleItems, sales, stockAdjustments,
  stockBalances, stockMovements, tenants, units, users, withTenantTransaction,
} from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createUnit } from "../lib/use-cases/catalog";
import { createCustomer } from "../lib/use-cases/customer";
import { createItem } from "../lib/use-cases/item";
import { adjustStock, completeCustomerReturn } from "../lib/use-cases/returns";
import { completeSale } from "../lib/use-cases/sale";
import { getProfitAndLoss } from "../lib/use-cases/profit-loss";

type Fixture = { tenantId: string; ctx: TenantContext; branchId: string; warehouseId: string };
let A: Fixture;
let B: Fixture;
let emptyLedger: Fixture;
let customerId: string; // customer returns require a customer on the originating sale

async function provision(label: string): Promise<Fixture> {
  const reg = await registerOwnerAndTenant({ email: `pl-${label}-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: `PL ${label}`, businessName: `PL Test ${label}` });
  const m = await db.query.memberships.findFirst({ where: (t, { eq: e }) => e(t.id, reg.membershipId) });
  const ctx: TenantContext = { requestId: randomUUID(), userId: reg.userId, tenantId: reg.tenantId, membershipId: reg.membershipId, roleId: m!.roleId, storageMode: "SHARED", permissions: await resolvePermissions(m!.roleId), roleKey: await resolveRoleKey(m!.roleId) };
  const branchId = (await withTenantTransaction(reg.tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq: e }) => e(b.tenantId, reg.tenantId) })))!.id;
  const warehouseId = (await withTenantTransaction(reg.tenantId, (tx) => tx.query.warehouses.findFirst({ where: (w, { eq: e }) => e(w.tenantId, reg.tenantId) })))!.id;
  return { tenantId: reg.tenantId, ctx, branchId, warehouseId };
}

async function cleanup(tenantId: string) {
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.delete(journalEntries).where(eq(journalEntries.tenantId, tenantId));
    await tx.delete(journals).where(eq(journals.tenantId, tenantId));
    await tx.delete(returnLines).where(eq(returnLines.tenantId, tenantId));
    await tx.delete(returnsTable).where(eq(returnsTable.tenantId, tenantId));
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.tenantId, tenantId));
    await tx.delete(payments).where(eq(payments.tenantId, tenantId));
    await tx.delete(receivables).where(eq(receivables.tenantId, tenantId));
    await tx.delete(saleItems).where(eq(saleItems.tenantId, tenantId));
    await tx.delete(sales).where(eq(sales.tenantId, tenantId));
    await tx.delete(stockMovements).where(eq(stockMovements.tenantId, tenantId));
    await tx.delete(stockAdjustments).where(eq(stockAdjustments.tenantId, tenantId));
    await tx.delete(stockBalances).where(eq(stockBalances.tenantId, tenantId));
    await tx.delete(items).where(eq(items.tenantId, tenantId));
    await tx.delete(units).where(eq(units.tenantId, tenantId));
    await tx.delete(customers).where(eq(customers.tenantId, tenantId));
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

const saleBody = (itemRow: { id: string; sellingPrice: string }, qty: string, orderDiscount: string, cash: string) =>
  ({ branchId: A.branchId, customerId, lines: [{ itemId: itemRow.id, quantity: qty, unitPrice: itemRow.sellingPrice, lineDiscount: "0", warehouseId: A.warehouseId }], orderDiscount, cashReceived: cash }) as never;

beforeAll(async () => {
  A = await provision("A");
  B = await provision("B");
  emptyLedger = await provision("Empty");
  customerId = (await createCustomer(A.ctx, { type: "INDIVIDUAL", name: "PL Test Customer" } as never)).id;
  const unit = await createUnit(A.ctx, { name: `U-${randomUUID()}`, symbol: "pc" } as never);
  const item = await createItem(A.ctx, { name: `PL Item ${randomUUID()}`, type: "PRODUCT", unitId: unit.id, sellingPrice: "500.00", purchasePrice: "300.00", stockTracked: true } as never);
  await adjustStock(A.ctx, { itemId: item.id, warehouseId: A.warehouseId, quantityDelta: "50", reason: "seed" } as never, randomUUID());

  const sale1 = await completeSale(A.ctx, saleBody(item, "4", "0", "2000"), randomUUID());
  await completeSale(A.ctx, saleBody(item, "2", "100", "900"), randomUUID());
  const line = await withTenantTransaction(A.tenantId, (tx) => tx.query.saleItems.findFirst({ where: (si, { eq: e }) => e(si.saleId, sale1.id) }));
  await completeCustomerReturn(A.ctx, { saleId: sale1.id, warehouseId: A.warehouseId, lines: [{ sourceLineId: line!.id, quantity: "1", condition: "UNSELLABLE" }] } as never, randomUUID());
}, 90_000);

afterAll(async () => {
  for (const f of [A, B, emptyLedger]) if (f) await cleanup(f.tenantId);
});

describe("getProfitAndLoss -- 08 s6.2 formulas on real postings", () => {
  it("computes Revenue / COGS / Gross / Opex / Net exactly from the ledger", async () => {
    const pl = await getProfitAndLoss(A.ctx);
    expect(pl.revenue.total).toBe("2500");
    expect(pl.cogs.total).toBe("1500");
    expect(pl.grossProfit).toBe("1000");
    expect(pl.operatingExpenses.total).toBe("400");
    expect(pl.netProfit).toBe("600");
  });

  it("classifies lines per spec: revenue from INCOME, discount + write-off as operating expense, COGS excluded from opex", async () => {
    const pl = await getProfitAndLoss(A.ctx);
    expect(pl.revenue.lines).toEqual([{ code: "4000", name: "Sales Revenue", amount: "2500" }]);
    expect(pl.operatingExpenses.lines.map((l) => [l.code, l.amount])).toEqual([["5100", "100"], ["5500", "300"]]);
    expect(pl.operatingExpenses.lines.some((l) => l.code === "5000")).toBe(false);
  });

  it("identities hold: Gross = Revenue - COGS and Net = Gross - Opex", async () => {
    const pl = await getProfitAndLoss(A.ctx);
    expect(Number(pl.grossProfit)).toBe(Number(pl.revenue.total) - Number(pl.cogs.total));
    expect(Number(pl.netProfit)).toBe(Number(pl.grossProfit) - Number(pl.operatingExpenses.total));
  });
});

describe("getProfitAndLoss -- reconciliation against the raw ledger", () => {
  it("Net Profit equals an independent SUM over INCOME/EXPENSE journal entries, and the whole ledger balances", async () => {
    const pl = await getProfitAndLoss(A.ctx);
    const [check] = await withTenantTransaction(A.tenantId, (tx) =>
      tx
        .select({
          net: sql<string>`coalesce(sum(case when ${accounts.type} = 'INCOME' then ${journalEntries.credit} - ${journalEntries.debit} when ${accounts.type} = 'EXPENSE' then ${journalEntries.credit} - ${journalEntries.debit} else 0 end), 0)`,
          totalDebit: sql<string>`coalesce(sum(${journalEntries.debit}), 0)`,
          totalCredit: sql<string>`coalesce(sum(${journalEntries.credit}), 0)`,
        })
        .from(journalEntries)
        .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
        .where(eq(journalEntries.tenantId, A.tenantId)),
    );
    // Income is credit-normal and expense debit-normal, so (credit - debit) over both types IS net profit.
    expect(Number(check!.net)).toBe(Number(pl.netProfit));
    expect(Number(check!.totalDebit)).toBe(Number(check!.totalCredit)); // Total Debit = Total Credit
  });
});

describe("getProfitAndLoss -- date range (journals.posted_at, UTC days)", () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  it("includes today's postings when the range covers today", async () => {
    expect((await getProfitAndLoss(A.ctx, { dateFrom: day(-1), dateTo: day(1) })).netProfit).toBe("600");
  });

  it("returns zeros for a range that ends before the postings", async () => {
    const pl = await getProfitAndLoss(A.ctx, { dateFrom: day(-30), dateTo: day(-10) });
    expect([pl.revenue.total, pl.cogs.total, pl.operatingExpenses.total, pl.netProfit]).toEqual(["0", "0", "0", "0"]);
    expect(pl.revenue.lines).toEqual([]);
  });

  it("returns zeros for a range that starts after the postings", async () => {
    expect((await getProfitAndLoss(A.ctx, { dateFrom: day(10) })).netProfit).toBe("0");
  });

  it("echoes the requested period", async () => {
    expect((await getProfitAndLoss(A.ctx, { dateFrom: "2026-01-01", dateTo: "2026-01-31" })).period).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect((await getProfitAndLoss(A.ctx)).period).toEqual({ dateFrom: null, dateTo: null });
  });
});

describe("getProfitAndLoss -- tenant isolation and empty ledger", () => {
  it("Tenant B sees none of Tenant A's revenue, cost or expenses", async () => {
    const pl = await getProfitAndLoss(B.ctx);
    expect([pl.revenue.total, pl.cogs.total, pl.operatingExpenses.total, pl.netProfit]).toEqual(["0", "0", "0", "0"]);
    expect(pl.revenue.lines).toEqual([]);
    expect(pl.operatingExpenses.lines).toEqual([]);
  });

  it("a tenant with no journals gets an all-zero report, not an error", async () => {
    expect((await getProfitAndLoss(emptyLedger.ctx)).netProfit).toBe("0");
  });

  it("Tenant A is unchanged after other tenants were queried (no context leakage)", async () => {
    await getProfitAndLoss(B.ctx);
    expect((await getProfitAndLoss(A.ctx)).netProfit).toBe("600");
  });
});
