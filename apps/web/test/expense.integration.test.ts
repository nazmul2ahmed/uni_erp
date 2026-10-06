/**
 * Expense domain -- real-PostgreSQL integration test.
 * 07 s14 (RecordExpenseUseCase), 08 s5.7 / s10.3, 06 s5.13, 11 s13;
 * Decisions EXP-001 (category -> account), EXP-002 (CASH|BANK), EXP-003 (date).
 *
 * Two tenants (24 s9.1). Proves: correct, balanced double-entry; idempotent
 * replay; backdated expenses land in their own period; posted expenses are
 * immutable for the runtime role (RLS append-only); Tenant B can never use or
 * see Tenant A's categories/branches/expenses; P&L picks the expense up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accounts, auditLogs, db, expenseCategories, expenses, journalEntries, journals, memberships, roles, rolePermissions,
  tenants, users, withTenantTransaction,
} from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { createExpenseCategory, ensureDefaultExpenseCategories, listExpenseCategories, listExpenses, recordExpense } from "../lib/use-cases/expense";
import { getProfitAndLoss } from "../lib/use-cases/profit-loss";
import { todayInTimezone } from "../lib/tenant-date";
import { DEFAULT_EXPENSE_CATEGORIES } from "@erp/validation";

type Fixture = { tenantId: string; userId: string; ctx: TenantContext; branchId: string };
let A: Fixture;
let B: Fixture;
let rentCategoryId: string;

async function provision(label: string): Promise<Fixture> {
  const reg = await registerOwnerAndTenant({ email: `exp-${label}-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: `Exp ${label}`, businessName: `Exp Test ${label}` });
  const m = await db.query.memberships.findFirst({ where: (t, { eq: e }) => e(t.id, reg.membershipId) });
  const ctx: TenantContext = { requestId: randomUUID(), userId: reg.userId, tenantId: reg.tenantId, membershipId: reg.membershipId, roleId: m!.roleId, storageMode: "SHARED", permissions: await resolvePermissions(m!.roleId), roleKey: await resolveRoleKey(m!.roleId) };
  const branchId = (await withTenantTransaction(reg.tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq: e }) => e(b.tenantId, reg.tenantId) })))!.id;
  return { tenantId: reg.tenantId, userId: reg.userId, ctx, branchId };
}

async function cleanup(f: Fixture | undefined) {
  if (!f) return;
  const ms = await db.query.memberships.findMany({ where: eq(memberships.tenantId, f.tenantId) });
  // Deleting the tenant cascades to core.* (incl. append-only expenses -- FK cascades bypass RLS).
  await db.delete(memberships).where(eq(memberships.tenantId, f.tenantId)).catch(() => undefined);
  for (const r of await db.query.roles.findMany({ where: eq(roles.tenantId, f.tenantId) })) await db.delete(rolePermissions).where(eq(rolePermissions.roleId, r.id)).catch(() => undefined);
  await db.delete(roles).where(eq(roles.tenantId, f.tenantId)).catch(() => undefined);
  await db.delete(tenants).where(eq(tenants.id, f.tenantId)).catch(() => undefined);
  for (const m of ms) await db.delete(users).where(eq(users.id, m.userId)).catch(() => undefined);
}

const today = () => todayInTimezone("Asia/Dhaka");
const dayOffset = (n: number) => { const d = new Date(`${today()}T12:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const body = (over: Partial<Parameters<typeof recordExpense>[1]> = {}) => ({ branchId: A.branchId, categoryId: rentCategoryId, amount: "1500.50", paidVia: "CASH" as const, expenseDate: today(), description: "Shop rent", ...over });

async function journalFor(tenantId: string, expenseId: string) {
  return withTenantTransaction(tenantId, async (tx) => {
    const js = await tx.query.journals.findMany({ where: and(eq(journals.tenantId, tenantId), eq(journals.referenceType, "EXPENSE"), eq(journals.referenceId, expenseId)) });
    const lines = js.length
      ? await tx.select({ code: accounts.code, debit: journalEntries.debit, credit: journalEntries.credit }).from(journalEntries).innerJoin(accounts, eq(accounts.id, journalEntries.accountId)).where(eq(journalEntries.journalId, js[0]!.id))
      : [];
    return { journals: js, lines };
  });
}

beforeAll(async () => {
  A = await provision("A");
  B = await provision("B");
  // Decision EXP-004: onboarding already provisioned the standard categories.
  rentCategoryId = (await listExpenseCategories(A.ctx)).find((c) => c.name === "Rent")!.id;
}, 60_000);

afterAll(async () => {
  await cleanup(A);
  await cleanup(B);
});

describe("default categories at onboarding (Decision EXP-004)", () => {
  it("a new tenant starts with the standard categories, each mapped to its 08 s3.5 account", async () => {
    const list = await listExpenseCategories(B.ctx);
    expect(list.map((c) => [c.name, c.accountCode]).sort()).toEqual(DEFAULT_EXPENSE_CATEGORIES.map((d) => [d.name, d.accountCode]).sort());
    expect(list.every((c) => c.isActive)).toBe(true);
  });

  it("the very first expense can be recorded with no setup at all", async () => {
    const f = await provision("FirstRun");
    try {
      const cats = await listExpenseCategories(f.ctx);
      const salaries = cats.find((c) => c.name === "Salaries")!;
      const e = await recordExpense(f.ctx, { branchId: f.branchId, categoryId: salaries.id, amount: "30000", paidVia: "BANK", expenseDate: today() }, randomUUID());
      const { lines } = await journalFor(f.tenantId, e.id);
      expect(lines.map((l) => [l.code, Number(l.debit), Number(l.credit)]).sort()).toEqual([["1010", 0, 30000], ["5300", 30000, 0]]);
    } finally {
      await cleanup(f);
    }
  });

  it("ensureDefaultExpenseCategories is idempotent and never duplicates or overwrites", async () => {
    const before = await listExpenseCategories(A.ctx);
    await withTenantTransaction(A.tenantId, (tx) => ensureDefaultExpenseCategories(tx, A.tenantId));
    await withTenantTransaction(A.tenantId, (tx) => ensureDefaultExpenseCategories(tx, A.tenantId));
    const after = await listExpenseCategories(A.ctx);
    expect(after).toHaveLength(before.length);
    expect(after.find((c) => c.name === "Rent")!.id).toBe(rentCategoryId);
  });

  it("backfills an existing tenant that lacks them, skipping names it already has (case-insensitive)", async () => {
    const f = await provision("Backfill");
    try {
      await withTenantTransaction(f.tenantId, async (tx) => {
        await tx.delete(expenseCategories).where(eq(expenseCategories.tenantId, f.tenantId));
      });
      expect(await listExpenseCategories(f.ctx)).toHaveLength(0);
      await createExpenseCategory(f.ctx, { name: "rent", accountCode: "5400" }); // user's own, different account
      await withTenantTransaction(f.tenantId, (tx) => ensureDefaultExpenseCategories(tx, f.tenantId));
      const list = await listExpenseCategories(f.ctx);
      expect(list).toHaveLength(DEFAULT_EXPENSE_CATEGORIES.length);
      expect(list.find((c) => c.name === "rent")!.accountCode).toBe("5400"); // untouched, not replaced by the default Rent
    } finally {
      await cleanup(f);
    }
  });
});

describe("expense categories (Decision EXP-001)", () => {
  it("maps a category to its EXPENSE account, lazily provisioning the system account", async () => {
    const list = await listExpenseCategories(A.ctx);
    expect(list.find((c) => c.name === "Rent")).toMatchObject({ accountCode: "5200", accountName: "Rent Expense", isActive: true });
  });

  it("rejects a duplicate name, case-insensitively", async () => {
    await expect(createExpenseCategory(A.ctx, { name: "rent", accountCode: "5300" })).rejects.toMatchObject({ code: "DUPLICATE_RESOURCE" });
  });

  it.each([
    ["COGS 5000 (would distort Gross Profit)", "5000"],
    ["Discount Given 5100 (sale-posting only)", "5100"],
    ["Inventory Shrinkage 5500 (write-off posting only, Decision ACC-007)", "5500"],
    ["an ASSET account (Cash 1000)", "1000"],
    ["an account that does not exist", "5777"],
  ])("refuses %s", async (_label, code) => {
    await expect(createExpenseCategory(A.ctx, { name: `Bad ${code}`, accountCode: code })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("two categories may share one account (e.g. Rent and Shop Rent -> 5200)", async () => {
    const second = await createExpenseCategory(A.ctx, { name: "Warehouse Rent", accountCode: "5200" });
    expect(second.accountCode).toBe("5200");
  });
});

describe("recordExpense -- double-entry posting (08 s5.7)", () => {
  it("cash expense: Dr category account / Cr Cash, balanced, one journal, referenced to the expense", async () => {
    const e = await recordExpense(A.ctx, body(), randomUUID());
    expect(e.amount).toBe("1500.5000");
    const { journals: js, lines } = await journalFor(A.tenantId, e.id);
    expect(js).toHaveLength(1);
    expect(lines).toHaveLength(2);
    const debit = lines.find((l) => Number(l.debit) > 0)!;
    const credit = lines.find((l) => Number(l.credit) > 0)!;
    expect([debit.code, Number(debit.debit)]).toEqual(["5200", 1500.5]);
    expect([credit.code, Number(credit.credit)]).toEqual(["1000", 1500.5]);
  });

  it("bank expense credits Bank (1010) instead of Cash", async () => {
    const e = await recordExpense(A.ctx, body({ paidVia: "BANK", amount: "200" }), randomUUID());
    const { lines } = await journalFor(A.tenantId, e.id);
    expect(lines.find((l) => Number(l.credit) > 0)!.code).toBe("1010");
  });

  it("writes an audit record (07 s15)", async () => {
    const e = await recordExpense(A.ctx, body({ amount: "10" }), randomUUID());
    const rows = await withTenantTransaction(A.tenantId, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.tenantId, A.tenantId), eq(auditLogs.entityId, e.id))));
    expect(rows.map((r) => r.action)).toEqual(["expense.record"]);
  });
});

describe("recordExpense -- idempotency", () => {
  it("replaying the same key + payload returns the same expense and posts exactly one journal", async () => {
    const key = randomUUID();
    const first = await recordExpense(A.ctx, body({ amount: "77" }), key);
    const second = await recordExpense(A.ctx, body({ amount: "77" }), key);
    expect(second.id).toBe(first.id);
    expect((await journalFor(A.tenantId, first.id)).journals).toHaveLength(1);
    const rows = await withTenantTransaction(A.tenantId, (tx) => tx.select().from(expenses).where(and(eq(expenses.tenantId, A.tenantId), eq(expenses.operationId, key))));
    expect(rows).toHaveLength(1);
  });

  it("treats numerically-equal amounts as the same payload ('77' vs '77.0000')", async () => {
    const key = randomUUID();
    const first = await recordExpense(A.ctx, body({ amount: "5" }), key);
    expect((await recordExpense(A.ctx, body({ amount: "5.0000" }), key)).id).toBe(first.id);
  });

  it("the same key with a DIFFERENT payload is refused, not silently replayed", async () => {
    const key = randomUUID();
    await recordExpense(A.ctx, body({ amount: "50" }), key);
    await expect(recordExpense(A.ctx, body({ amount: "51" }), key)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("concurrent duplicate requests with one key produce one expense and one journal", async () => {
    const key = randomUUID();
    const results = await Promise.allSettled([recordExpense(A.ctx, body({ amount: "33" }), key), recordExpense(A.ctx, body({ amount: "33" }), key)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const rows = await withTenantTransaction(A.tenantId, (tx) => tx.select().from(expenses).where(and(eq(expenses.tenantId, A.tenantId), eq(expenses.operationId, key))));
    expect(rows).toHaveLength(1);
    expect((await journalFor(A.tenantId, rows[0]!.id)).journals).toHaveLength(1);
  });
});

describe("recordExpense -- dates (Decision EXP-003)", () => {
  it("rejects a future expenseDate (tenant timezone)", async () => {
    await expect(recordExpense(A.ctx, body({ expenseDate: dayOffset(2) }), randomUUID())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("a backdated expense is journalled on its own date and lands in THAT period's P&L only", async () => {
    const f = await provision("Backdate");
    try {
      const cat = (await listExpenseCategories(f.ctx)).find((c) => c.name === "Utilities")!.id;
      const past = dayOffset(-20);
      const e = await recordExpense(f.ctx, { branchId: f.branchId, categoryId: cat, amount: "900", paidVia: "CASH", expenseDate: past }, randomUUID());
      const { journals: js } = await journalFor(f.tenantId, e.id);
      expect(js[0]!.postedAt.toISOString().slice(0, 10)).toBe(past);

      const inPeriod = await getProfitAndLoss(f.ctx, { dateFrom: dayOffset(-25), dateTo: dayOffset(-15) });
      expect([inPeriod.operatingExpenses.total, inPeriod.netProfit]).toEqual(["900", "-900"]);
      expect(inPeriod.operatingExpenses.lines).toEqual([{ code: "5400", name: "Utility Expense", amount: "900" }]);

      const thisMonthOnly = await getProfitAndLoss(f.ctx, { dateFrom: dayOffset(-5), dateTo: dayOffset(1) });
      expect(thisMonthOnly.operatingExpenses.total).toBe("0");
    } finally {
      await cleanup(f);
    }
  });
});

describe("recordExpense -- validity checks", () => {
  it("rejects an inactive category", async () => {
    const c = await createExpenseCategory(A.ctx, { name: `Retired ${randomUUID().slice(0, 8)}`, accountCode: "5900" });
    await withTenantTransaction(A.tenantId, (tx) => tx.update(expenseCategories).set({ isActive: false }).where(eq(expenseCategories.id, c.id)));
    await expect(recordExpense(A.ctx, body({ categoryId: c.id }), randomUUID())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects an unknown category or branch with 404", async () => {
    await expect(recordExpense(A.ctx, body({ categoryId: randomUUID() }), randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(recordExpense(A.ctx, body({ branchId: randomUUID() }), randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

describe("immutability -- a posted expense is a business fact", () => {
  it("the runtime role cannot UPDATE or DELETE a posted expense (RLS append-only)", async () => {
    const e = await recordExpense(A.ctx, body({ amount: "123" }), randomUUID());
    const updated = await withTenantTransaction(A.tenantId, (tx) => tx.update(expenses).set({ amount: "1" }).where(eq(expenses.id, e.id)).returning());
    const deleted = await withTenantTransaction(A.tenantId, (tx) => tx.delete(expenses).where(eq(expenses.id, e.id)).returning());
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
    const still = await withTenantTransaction(A.tenantId, (tx) => tx.query.expenses.findFirst({ where: eq(expenses.id, e.id) }));
    expect(still?.amount).toBe("123.0000");
  });

  it("the database rejects a non-positive amount (CHECK) even if the application were bypassed", async () => {
    await expect(
      withTenantTransaction(A.tenantId, (tx) => tx.insert(expenses).values({ tenantId: A.tenantId, branchId: A.branchId, categoryId: rentCategoryId, amount: "0", paidVia: "CASH", expenseDate: today(), operationId: randomUUID() })),
    ).rejects.toThrow();
  });
});

describe("tenant isolation", () => {
  it("Tenant B cannot use Tenant A's category or branch (404, nothing posted)", async () => {
    const before = await withTenantTransaction(B.tenantId, (tx) => tx.select().from(journals).where(eq(journals.tenantId, B.tenantId)));
    await expect(recordExpense(B.ctx, { branchId: B.branchId, categoryId: rentCategoryId, amount: "10", paidVia: "CASH", expenseDate: today() }, randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const bCategory = (await listExpenseCategories(B.ctx)).find((c) => c.name === "Rent")!.id;
    await expect(recordExpense(B.ctx, { branchId: A.branchId, categoryId: bCategory, amount: "10", paidVia: "CASH", expenseDate: today() }, randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const after = await withTenantTransaction(B.tenantId, (tx) => tx.select().from(journals).where(eq(journals.tenantId, B.tenantId)));
    expect(after).toHaveLength(before.length);
  });

  it("Tenant B lists none of Tenant A's expenses, and has its own same-named category", async () => {
    expect(await listExpenses(B.ctx)).toEqual([]);
    const cats = await listExpenseCategories(B.ctx);
    const bRent = cats.find((c) => c.name === "Rent")!;
    expect(bRent.id).not.toBe(rentCategoryId);
    expect(cats.map((c) => c.id)).not.toContain(rentCategoryId);
  });

  it("Tenant A still sees its own expenses afterwards (no context leakage)", async () => {
    expect((await listExpenses(A.ctx)).length).toBeGreaterThan(0);
  });
});

describe("listing and ledger invariants", () => {
  it("filters by category and date range, newest first", async () => {
    const rows = await listExpenses(A.ctx, { categoryId: rentCategoryId, dateFrom: today(), dateTo: today() });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.categoryId === rentCategoryId && r.expenseDate === today())).toBe(true);
    expect(rows[0]).toHaveProperty("categoryName", "Rent");
  });

  it("A's ledger balances (Total Debit = Total Credit) and its P&L operating expenses equal the sum of recorded expenses", async () => {
    const totals = await withTenantTransaction(A.tenantId, async (tx) => {
      const lines = await tx.select({ d: journalEntries.debit, c: journalEntries.credit }).from(journalEntries).where(eq(journalEntries.tenantId, A.tenantId));
      const recorded = await tx.select({ amount: expenses.amount }).from(expenses).where(eq(expenses.tenantId, A.tenantId));
      return { debit: lines.reduce((s, l) => s + Number(l.d), 0), credit: lines.reduce((s, l) => s + Number(l.c), 0), expenseSum: recorded.reduce((s, r) => s + Number(r.amount), 0) };
    });
    expect(totals.debit).toBeCloseTo(totals.credit, 4);
    const pl = await getProfitAndLoss(A.ctx);
    expect(Number(pl.operatingExpenses.total)).toBeCloseTo(totals.expenseSum, 4);
    expect(Number(pl.netProfit)).toBeCloseTo(-totals.expenseSum, 4);
  });
});

describe("permissions (seeded presets)", () => {
  const presetPerms = async (key: string) => {
    const role = await db.query.roles.findFirst({ where: (r, { and: a, eq: e, isNull }) => a(isNull(r.tenantId), e(r.key, key)) });
    return resolvePermissions(role!.id);
  };
  it("OWNER and MANAGER can view/create/manage; STAFF can view/create but NOT manage categories", async () => {
    for (const key of ["OWNER", "MANAGER"]) expect(await presetPerms(key)).toEqual(expect.arrayContaining(["expenses.view", "expenses.create", "expenses.manage"]));
    const staff = await presetPerms("STAFF");
    expect(staff).toEqual(expect.arrayContaining(["expenses.view", "expenses.create"]));
    expect(staff).not.toContain("expenses.manage");
  });
});
