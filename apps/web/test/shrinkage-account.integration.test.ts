/**
 * Decision ACC-007 -- "Other Expense" (5900) and "Inventory Shrinkage/Expiry Expense" (5500) are separate accounts.
 * Before this decision both landed on 5900 and the P&L showed them as one line.
 * Real PostgreSQL; the session is not involved (use cases are called directly).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accounts, createOwnerDb, db, memberships, roles, rolePermissions, tenants, users, withTenantTransaction } from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createUnit } from "../lib/use-cases/catalog";
import { createCustomer } from "../lib/use-cases/customer";
import { createItem } from "../lib/use-cases/item";
import { adjustStock, completeCustomerReturn } from "../lib/use-cases/returns";
import { completeSale } from "../lib/use-cases/sale";
import { listExpenseCategories, recordExpense } from "../lib/use-cases/expense";
import { getProfitAndLoss } from "../lib/use-cases/profit-loss";
import { todayInTimezone } from "../lib/tenant-date";

const owner = createOwnerDb();
let tenantId: string, userId: string, ctx: TenantContext, branchId: string, warehouseId: string;

beforeAll(async () => {
  const reg = await registerOwnerAndTenant({ email: `acc7-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: "Acc7", businessName: "Acc7 Test" });
  const m = await db.query.memberships.findFirst({ where: eq(memberships.id, reg.membershipId) });
  tenantId = reg.tenantId; userId = reg.userId;
  ctx = { requestId: randomUUID(), userId, tenantId, membershipId: reg.membershipId, roleId: m!.roleId, storageMode: "SHARED", permissions: await resolvePermissions(m!.roleId), roleKey: await resolveRoleKey(m!.roleId) };
  branchId = (await withTenantTransaction(tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq: e }) => e(b.tenantId, tenantId) })))!.id;
  warehouseId = (await withTenantTransaction(tenantId, (tx) => tx.query.warehouses.findFirst({ where: (w, { eq: e }) => e(w.tenantId, tenantId) })))!.id;
}, 60_000);

afterAll(async () => {
  await owner.db.delete(tenants).where(eq(tenants.id, tenantId)).catch(() => undefined); // cascades core.*
  for (const r of await owner.db.query.roles.findMany({ where: eq(roles.tenantId, tenantId) })) await owner.db.delete(rolePermissions).where(eq(rolePermissions.roleId, r.id)).catch(() => undefined);
  await owner.db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
  await owner.close();
});

describe("write-offs and 'Other expenses' no longer share an account", () => {
  it("an unsellable customer return posts to 5500, an 'Other expenses' expense posts to 5900, and the P&L shows two lines", async () => {
    const unit = await createUnit(ctx, { name: `U-${randomUUID()}`, symbol: "pc" } as never);
    const item = await createItem(ctx, { name: `Acc7 Item ${randomUUID()}`, type: "PRODUCT", unitId: unit.id, sellingPrice: "500.00", purchasePrice: "300.00", stockTracked: true } as never);
    await adjustStock(ctx, { itemId: item.id, warehouseId, quantityDelta: "10", reason: "seed" } as never, randomUUID());
    const customer = await createCustomer(ctx, { type: "INDIVIDUAL", name: "Acc7 Customer" } as never);
    const sale = await completeSale(ctx, { branchId, customerId: customer.id, lines: [{ itemId: item.id, quantity: "2", unitPrice: item.sellingPrice, lineDiscount: "0", warehouseId }], orderDiscount: "0", cashReceived: "1000" } as never, randomUUID());
    const line = await withTenantTransaction(tenantId, (tx) => tx.query.saleItems.findFirst({ where: (si, { eq: e }) => e(si.saleId, sale.id) }));
    await completeCustomerReturn(ctx, { saleId: sale.id, warehouseId, lines: [{ sourceLineId: line!.id, quantity: "1", condition: "UNSELLABLE" }] } as never, randomUUID());

    const other = (await listExpenseCategories(ctx)).find((c) => c.name === "Other expenses")!;
    expect(other.accountCode).toBe("5900");
    await recordExpense(ctx, { branchId, categoryId: other.id, amount: "50", paidVia: "CASH", expenseDate: todayInTimezone("Asia/Dhaka") }, randomUUID());

    const pl = await getProfitAndLoss(ctx);
    const byCode = Object.fromEntries(pl.operatingExpenses.lines.map((l) => [l.code, l]));
    expect(byCode["5500"]).toMatchObject({ name: "Inventory Shrinkage/Expiry Expense", amount: "300" }); // 1 x cost 300
    expect(byCode["5900"]).toMatchObject({ name: "Other Expense", amount: "50" });
    expect(pl.operatingExpenses.total).toBe("350");
  });

  it("new tenants label 5900 'Other Expense' from the start", async () => {
    const row = await withTenantTransaction(tenantId, (tx) => tx.query.accounts.findFirst({ where: (a, { and, eq: e }) => and(e(a.tenantId, tenantId), e(a.code, "5900")) }));
    expect(row?.name).toBe("Other Expense");
  });
});

describe("label-fix migration 0013 is safe for history (run for real against the database)", () => {
  const OLD = "Inventory Shrinkage/Expiry Expense";
  const migration = readFileSync(join(__dirname, "..", "..", "..", "packages", "db", "migrations-manual", "0013_split_other_expense_account.sql"), "utf8");
  const nameOf = async (tid: string) => (await owner.db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tid), eq(accounts.code, "5900")) }))?.name;

  it("renames a mislabelled 5900 that has no postings, never one that carries postings, and is idempotent", async () => {
    const reg2 = await registerOwnerAndTenant({ email: `acc7b-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: "Acc7b", businessName: "Acc7b Test" });
    try {
      // Reproduce two pre-ACC-007 tenants: same old label on 5900; only the main tenant has entries on it (the 'Other expenses' expense above).
      await owner.db.update(accounts).set({ name: OLD }).where(and(eq(accounts.code, "5900"), eq(accounts.tenantId, tenantId)));
      await owner.db.update(accounts).set({ name: OLD }).where(and(eq(accounts.code, "5900"), eq(accounts.tenantId, reg2.tenantId)));
      expect(await nameOf(tenantId)).toBe(OLD);
      expect(await nameOf(reg2.tenantId)).toBe(OLD);

      await owner.db.execute(sql.raw(migration));
      expect(await nameOf(reg2.tenantId)).toBe("Other Expense"); // untouched account: label corrected
      expect(await nameOf(tenantId)).toBe(OLD); // carries posted entries: history is not relabelled

      await owner.db.execute(sql.raw(migration)); // idempotent
      expect(await nameOf(reg2.tenantId)).toBe("Other Expense");
      expect(await nameOf(tenantId)).toBe(OLD);
    } finally {
      await owner.db.update(accounts).set({ name: "Other Expense" }).where(and(eq(accounts.code, "5900"), eq(accounts.tenantId, tenantId)));
      await owner.db.delete(tenants).where(eq(tenants.id, reg2.tenantId)).catch(() => undefined);
      for (const r of await owner.db.query.roles.findMany({ where: eq(roles.tenantId, reg2.tenantId) })) await owner.db.delete(rolePermissions).where(eq(rolePermissions.roleId, r.id)).catch(() => undefined);
      await owner.db.delete(users).where(eq(users.id, reg2.userId)).catch(() => undefined);
    }
  });
});
