/**
 * Dashboard Engine -- real-PostgreSQL integration test.
 * 12_UX_SPECIFICATION.md s8, 11_API_SPECIFICATION.md s19, Decision RPT-002.
 *
 * Two tenants (24 s9.1): Tenant A has one posted cash sale; Tenant B has
 * none. Proves (1) per-widget permission filtering against real data,
 * (2) financial widgets are withheld from a reports.view-only actor,
 * (3) Tenant B's dashboard never reflects Tenant A's sales / cash / stock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts, businessProfiles, db, items, journalEntries, journals, memberships, paymentAllocations, payments,
  receivables, roles, rolePermissions, saleItems, sales, stockAdjustments, stockBalances, stockMovements,
  tenants, units, users, withTenantTransaction,
} from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createUnit } from "../lib/use-cases/catalog";
import { createItem } from "../lib/use-cases/item";
import { adjustStock } from "../lib/use-cases/returns";
import { completeSale } from "../lib/use-cases/sale";
import { getDashboard } from "../lib/dashboard";

type Fixture = { tenantId: string; ctx: TenantContext; branchId: string; warehouseId: string };
let A: Fixture;
let B: Fixture;

async function provision(label: string): Promise<Fixture> {
  const reg = await registerOwnerAndTenant({ email: `dash-${label}-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: `Dash ${label}`, businessName: `Dash Test ${label}` });
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

beforeAll(async () => {
  A = await provision("A");
  B = await provision("B");
  // Tenant A: one stocked item, one posted cash sale of 2 x 500 = 1000.
  const unit = await createUnit(A.ctx, { name: `U-${randomUUID()}`, symbol: "pc" } as never);
  const item = await createItem(A.ctx, { name: `Dash Item ${randomUUID()}`, type: "PRODUCT", unitId: unit.id, sellingPrice: "500.00", purchasePrice: "300.00", stockTracked: true } as never);
  await adjustStock(A.ctx, { itemId: item.id, warehouseId: A.warehouseId, quantityDelta: "20", reason: "seed" } as never, randomUUID());
  await completeSale(A.ctx, { branchId: A.branchId, customerId: null, lines: [{ itemId: item.id, quantity: "2", unitPrice: item.sellingPrice, lineDiscount: "0", warehouseId: A.warehouseId }], orderDiscount: "0", cashReceived: "1000" } as never, randomUUID());
}, 60_000);

afterAll(async () => {
  if (A) await cleanup(A.tenantId);
  if (B) await cleanup(B.tenantId);
});

const keys = (d: Awaited<ReturnType<typeof getDashboard>>) => d.widgets.map((w) => w.key);
const data = <T,>(d: Awaited<ReturnType<typeof getDashboard>>, key: string) => d.widgets.find((w) => w.key === key)!.data as T;

describe("dashboard engine -- per-widget permissions (Decision RPT-002)", () => {
  it("OWNER (all permissions) gets every core widget, in registry order", async () => {
    const dash = await getDashboard(A.ctx);
    expect(keys(dash)).toEqual(["sales-summary", "low-stock", "cash-position", "receivables-due", "payables-due", "profit-snapshot"]);
    expect(dash.currency).toBeTruthy();
    expect(Number(data<{ summary: { grossSales: string; transactionCount: number } }>(dash, "sales-summary").summary.grossSales)).toBe(1000);
    expect(Number(data<{ cash: string }>(dash, "cash-position").cash)).toBe(1000);
    const profit = data<{ revenue: { total: string }; cogs: { total: string }; grossProfit: string; netProfit: string }>(dash, "profit-snapshot");
    expect([profit.revenue.total, profit.cogs.total, profit.grossProfit, profit.netProfit].map(Number)).toEqual([1000, 600, 400, 400]); // 2 x 500 sold at 2 x 300 cost
  });

  it("a reports.view-only actor gets sales + stock but NO ledger figures (cash/receivables/payables/profit withheld)", async () => {
    const dash = await getDashboard({ ...A.ctx, permissions: ["reports.view"] });
    expect(keys(dash)).toEqual(["sales-summary", "low-stock"]);
    expect(JSON.stringify(dash)).not.toMatch(/"cash"|"bank"|"receivables"|"payables"|netProfit|grossProfit/);
  });

  it("an accounting.view-only actor gets only the finance widgets", async () => {
    const dash = await getDashboard({ ...A.ctx, permissions: ["accounting.view"] });
    expect(keys(dash)).toEqual(["cash-position", "receivables-due", "payables-due"]); // profit-snapshot needs reports.view too
  });

  it("an actor with neither permission gets no widgets", async () => {
    expect((await getDashboard({ ...A.ctx, permissions: ["sales.view"] })).widgets).toEqual([]);
  });

  it("the seeded MANAGER role sees the same widget set as OWNER (holds reports.view + accounting.view)", async () => {
    const manager = await db.query.roles.findFirst({ where: (r, { and, eq: e, isNull }) => and(isNull(r.tenantId), e(r.key, "MANAGER")) });
    const dash = await getDashboard({ ...A.ctx, permissions: await resolvePermissions(manager!.id) });
    expect(keys(dash)).toEqual(["sales-summary", "low-stock", "cash-position", "receivables-due", "payables-due", "profit-snapshot"]);
  });

  it("the seeded STAFF role sees no widgets (no reports.view / accounting.view by default)", async () => {
    const staff = await db.query.roles.findFirst({ where: (r, { and, eq: e, isNull }) => and(isNull(r.tenantId), e(r.key, "STAFF")) });
    expect((await getDashboard({ ...A.ctx, permissions: await resolvePermissions(staff!.id) })).widgets).toEqual([]);
  });
});

describe("dashboard engine -- tenant isolation", () => {
  it("Tenant B's dashboard shows none of Tenant A's sales, cash or stock", async () => {
    const dash = await getDashboard(B.ctx);
    const s = data<{ summary: { transactionCount: number; grossSales: string }; topItems: unknown[]; trend: unknown[] }>(dash, "sales-summary");
    expect(Number(s.summary.transactionCount)).toBe(0);
    expect(Number(s.summary.grossSales)).toBe(0);
    expect(s.topItems).toHaveLength(0);
    expect(s.trend).toHaveLength(0);
    expect(Number(data<{ cash: string }>(dash, "cash-position").cash)).toBe(0);
    const profit = data<{ revenue: { total: string; lines: unknown[] }; netProfit: string }>(dash, "profit-snapshot");
    expect([Number(profit.revenue.total), Number(profit.netProfit), profit.revenue.lines.length]).toEqual([0, 0, 0]);
    expect(data<{ items: unknown[] }>(dash, "low-stock").items).toHaveLength(0);
  });

  it("Tenant A still sees its own data after Tenant B's dashboard was built (no context leakage)", async () => {
    await getDashboard(B.ctx);
    const dash = await getDashboard(A.ctx);
    expect(Number(data<{ summary: { transactionCount: number } }>(dash, "sales-summary").summary.transactionCount)).toBe(1);
  });
});
