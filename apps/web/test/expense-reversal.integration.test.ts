/**
 * Expense reversal -- real-PostgreSQL integration test.
 * 08 s5.9 (mechanical mirror), s10.3 (reverse + re-enter), INV-ACC-006,
 * Decision EXP-005; 07 s14, 11 s13.
 *
 * Proves: the reversal journal is the EXACT mirror and nets the original to
 * zero; P&L and cash return to where they were; one reversal per expense even
 * under concurrency; idempotency; tenant isolation; append-only link table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accounts, auditLogs, db, expenseReversals, expenses, journalEntries, journals, memberships, roles, rolePermissions,
  tenants, users, withTenantTransaction,
} from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { listExpenseCategories, listExpenses, recordExpense, reverseExpense } from "../lib/use-cases/expense";
import { getFinanceSummary } from "../lib/use-cases/finance";
import { getProfitAndLoss } from "../lib/use-cases/profit-loss";
import { todayInTimezone } from "../lib/tenant-date";

type Fixture = { tenantId: string; ctx: TenantContext; branchId: string; cat: Record<string, string> };
let A: Fixture;
let B: Fixture;

async function provision(label: string): Promise<Fixture> {
  const reg = await registerOwnerAndTenant({ email: `rev-${label}-${randomUUID()}@example.test`, password: "correct horse battery staple", fullName: `Rev ${label}`, businessName: `Rev Test ${label}` });
  const m = await db.query.memberships.findFirst({ where: (t, { eq: e }) => e(t.id, reg.membershipId) });
  const ctx: TenantContext = { requestId: randomUUID(), userId: reg.userId, tenantId: reg.tenantId, membershipId: reg.membershipId, roleId: m!.roleId, storageMode: "SHARED", permissions: await resolvePermissions(m!.roleId), roleKey: await resolveRoleKey(m!.roleId) };
  const branchId = (await withTenantTransaction(reg.tenantId, (tx) => tx.query.branches.findFirst({ where: (b, { eq: e }) => e(b.tenantId, reg.tenantId) })))!.id;
  const cat = Object.fromEntries((await listExpenseCategories(ctx)).map((c) => [c.name, c.id]));
  return { tenantId: reg.tenantId, ctx, branchId, cat };
}

async function cleanup(f: Fixture | undefined) {
  if (!f) return;
  const ms = await db.query.memberships.findMany({ where: eq(memberships.tenantId, f.tenantId) });
  await db.delete(memberships).where(eq(memberships.tenantId, f.tenantId)).catch(() => undefined);
  for (const r of await db.query.roles.findMany({ where: eq(roles.tenantId, f.tenantId) })) await db.delete(rolePermissions).where(eq(rolePermissions.roleId, r.id)).catch(() => undefined);
  await db.delete(roles).where(eq(roles.tenantId, f.tenantId)).catch(() => undefined);
  await db.delete(tenants).where(eq(tenants.id, f.tenantId)).catch(() => undefined);
  for (const m of ms) await db.delete(users).where(eq(users.id, m.userId)).catch(() => undefined);
}

const today = () => todayInTimezone("Asia/Dhaka");
const dayOffset = (n: number) => { const d = new Date(`${today()}T12:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const expenseBody = (f: Fixture, over: Partial<Parameters<typeof recordExpense>[1]> = {}) => ({ branchId: f.branchId, categoryId: f.cat["Rent"]!, amount: "500", paidVia: "CASH" as const, expenseDate: today(), ...over });

async function journalLines(tenantId: string, journalId: string) {
  return withTenantTransaction(tenantId, (tx) =>
    tx.select({ code: accounts.code, debit: journalEntries.debit, credit: journalEntries.credit }).from(journalEntries).innerJoin(accounts, eq(accounts.id, journalEntries.accountId)).where(eq(journalEntries.journalId, journalId)),
  );
}
const journalsOf = (tenantId: string, type: string, refId: string) =>
  withTenantTransaction(tenantId, (tx) => tx.query.journals.findMany({ where: and(eq(journals.tenantId, tenantId), eq(journals.referenceType, type), eq(journals.referenceId, refId)) }));

beforeAll(async () => {
  A = await provision("A");
  B = await provision("B");
}, 60_000);
afterAll(async () => { await cleanup(A); await cleanup(B); });

describe("reverseExpense -- the exact mirror (08 s5.9, INV-ACC-006)", () => {
  it("posts a REVERSAL journal pointing at the original, with debit/credit swapped on the same accounts and amounts", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A, { amount: "1234.5" }), randomUUID());
    const [orig] = await journalsOf(A.tenantId, "EXPENSE", e.id);
    const r = await reverseExpense(A.ctx, e.id, { reason: "Entered twice" }, randomUUID());
    const [rev] = await journalsOf(A.tenantId, "REVERSAL", orig!.id);

    expect(rev!.id).toBe(r.reversalJournalId);
    expect(rev!.referenceId).toBe(orig!.id);
    expect(rev!.description).toBe("Reversal: Entered twice");

    const o = await journalLines(A.tenantId, orig!.id);
    const x = await journalLines(A.tenantId, rev!.id);
    expect(x).toHaveLength(o.length);
    for (const line of o) {
      const mirrored = x.find((l) => l.code === line.code)!;
      expect([Number(mirrored.debit), Number(mirrored.credit)]).toEqual([Number(line.credit), Number(line.debit)]);
    }
  });

  it("INV-ACC-006: original + reversal net to zero per account, and the reversal itself balances", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A, { amount: "77.7" }), randomUUID());
    const [orig] = await journalsOf(A.tenantId, "EXPENSE", e.id);
    await reverseExpense(A.ctx, e.id, { reason: "Wrong amount" }, randomUUID());
    const [rev] = await journalsOf(A.tenantId, "REVERSAL", orig!.id);
    const all = [...(await journalLines(A.tenantId, orig!.id)), ...(await journalLines(A.tenantId, rev!.id))];
    const netByAccount = new Map<string, number>();
    for (const l of all) netByAccount.set(l.code, (netByAccount.get(l.code) ?? 0) + Number(l.debit) - Number(l.credit));
    expect([...netByAccount.values()].every((v) => Math.abs(v) < 1e-9)).toBe(true);
    const rl = await journalLines(A.tenantId, rev!.id);
    expect(rl.reduce((s, l) => s + Number(l.debit), 0)).toBeCloseTo(rl.reduce((s, l) => s + Number(l.credit), 0), 4);
  });

  it("the reversal takes the ORIGINAL's accounting date (the original period nets out)", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A, { expenseDate: dayOffset(-12) }), randomUUID());
    const [orig] = await journalsOf(A.tenantId, "EXPENSE", e.id);
    await reverseExpense(A.ctx, e.id, { reason: "Duplicate" }, randomUUID());
    const [rev] = await journalsOf(A.tenantId, "REVERSAL", orig!.id);
    expect(rev!.postedAt.toISOString()).toBe(orig!.postedAt.toISOString());
  });
});

describe("reverseExpense -- effect on the books", () => {
  it("cash and P&L return exactly to where they were, in the expense's own period", async () => {
    const f = await provision("Books");
    try {
      const before = await getFinanceSummary(f.ctx);
      const past = dayOffset(-20);
      const e = await recordExpense(f.ctx, { branchId: f.branchId, categoryId: f.cat["Utilities"]!, amount: "900", paidVia: "CASH", expenseDate: past }, randomUUID());
      expect(Number((await getFinanceSummary(f.ctx)).cash)).toBe(Number(before.cash) - 900);
      expect((await getProfitAndLoss(f.ctx, { dateFrom: dayOffset(-25), dateTo: dayOffset(-15) })).netProfit).toBe("-900");

      await reverseExpense(f.ctx, e.id, { reason: "Not ours" }, randomUUID());
      expect(Number((await getFinanceSummary(f.ctx)).cash)).toBe(Number(before.cash));
      const pl = await getProfitAndLoss(f.ctx, { dateFrom: dayOffset(-25), dateTo: dayOffset(-15) });
      expect([pl.operatingExpenses.total, pl.netProfit]).toEqual(["0", "0"]);
    } finally { await cleanup(f); }
  });

  it("bank expenses restore the bank balance", async () => {
    const f = await provision("Bank");
    try {
      const e = await recordExpense(f.ctx, { branchId: f.branchId, categoryId: f.cat["Salaries"]!, amount: "4000", paidVia: "BANK", expenseDate: today() }, randomUUID());
      expect(Number((await getFinanceSummary(f.ctx)).bank)).toBe(-4000);
      await reverseExpense(f.ctx, e.id, { reason: "Paid from cash instead" }, randomUUID());
      expect(Number((await getFinanceSummary(f.ctx)).bank)).toBe(0);
    } finally { await cleanup(f); }
  });

  it("reverse + re-enter in the right category leaves only the corrected expense in the P&L (08 s10.3)", async () => {
    const f = await provision("Correct");
    try {
      const wrong = await recordExpense(f.ctx, { branchId: f.branchId, categoryId: f.cat["Rent"]!, amount: "500", paidVia: "CASH", expenseDate: today() }, randomUUID());
      await reverseExpense(f.ctx, wrong.id, { reason: "Wrong category" }, randomUUID());
      await recordExpense(f.ctx, { branchId: f.branchId, categoryId: f.cat["Utilities"]!, amount: "500", paidVia: "CASH", expenseDate: today() }, randomUUID());
      const pl = await getProfitAndLoss(f.ctx);
      expect(pl.operatingExpenses.total).toBe("500");
      expect(pl.netProfit).toBe("-500");
      const byCode = Object.fromEntries(pl.operatingExpenses.lines.map((l) => [l.code, l.amount]));
      expect(byCode["5400"]).toBe("500"); // Utilities
      expect(byCode["5200"] ?? "0").toBe("0"); // Rent netted out
    } finally { await cleanup(f); }
  });
});

describe("reverseExpense -- once only, idempotent", () => {
  it("replaying the same key and request returns the same reversal and posts one journal", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A), randomUUID());
    const key = randomUUID();
    const first = await reverseExpense(A.ctx, e.id, { reason: "Mistake" }, key);
    const second = await reverseExpense(A.ctx, e.id, { reason: "Mistake" }, key);
    expect(second.id).toBe(first.id);
    const [orig] = await journalsOf(A.tenantId, "EXPENSE", e.id);
    expect(await journalsOf(A.tenantId, "REVERSAL", orig!.id)).toHaveLength(1);
  });

  it("the same key for a DIFFERENT expense or reason is refused", async () => {
    const e1 = await recordExpense(A.ctx, expenseBody(A), randomUUID());
    const e2 = await recordExpense(A.ctx, expenseBody(A), randomUUID());
    const key = randomUUID();
    await reverseExpense(A.ctx, e1.id, { reason: "Mistake" }, key);
    await expect(reverseExpense(A.ctx, e2.id, { reason: "Mistake" }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(reverseExpense(A.ctx, e1.id, { reason: "Another reason" }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("a second reversal under a NEW key is refused (ALREADY_REVERSED) and posts nothing", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A), randomUUID());
    await reverseExpense(A.ctx, e.id, { reason: "Mistake" }, randomUUID());
    await expect(reverseExpense(A.ctx, e.id, { reason: "Again" }, randomUUID())).rejects.toMatchObject({ code: "ALREADY_REVERSED" });
    const [orig] = await journalsOf(A.tenantId, "EXPENSE", e.id);
    expect(await journalsOf(A.tenantId, "REVERSAL", orig!.id)).toHaveLength(1);
  });

  it("concurrent reversals with different keys: exactly one wins, the other is ALREADY_REVERSED", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A, { amount: "321" }), randomUUID());
    const results = await Promise.allSettled([
      reverseExpense(A.ctx, e.id, { reason: "Race one" }, randomUUID()),
      reverseExpense(A.ctx, e.id, { reason: "Race two" }, randomUUID()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "ALREADY_REVERSED" });
    const [orig] = await journalsOf(A.tenantId, "EXPENSE", e.id);
    expect(await journalsOf(A.tenantId, "REVERSAL", orig!.id)).toHaveLength(1);
  });

  it("reusing the ORIGINAL expense's own Idempotency-Key must not collapse onto the original journal", async () => {
    const key = randomUUID();
    const e = await recordExpense(A.ctx, expenseBody(A, { amount: "42" }), key);
    const r = await reverseExpense(A.ctx, e.id, { reason: "Same key by mistake" }, key);
    const [orig] = await journalsOf(A.tenantId, "EXPENSE", e.id);
    expect(r.reversalJournalId).not.toBe(orig!.id);
    expect(await journalsOf(A.tenantId, "REVERSAL", orig!.id)).toHaveLength(1);
  });
});

describe("reverseExpense -- validation, isolation, audit", () => {
  it("requires a real reason", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A), randomUUID());
    for (const reason of ["", "  ", "ab"]) await expect(reverseExpense(A.ctx, e.id, { reason }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await withTenantTransaction(A.tenantId, (tx) => tx.query.expenseReversals.findFirst({ where: eq(expenseReversals.expenseId, e.id) }))).toBeUndefined();
  });

  it("an unknown expense is 404", async () => {
    await expect(reverseExpense(A.ctx, randomUUID(), { reason: "Nope" }, randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("Tenant B cannot reverse Tenant A's expense: 404, A's books untouched", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A, { amount: "260" }), randomUUID());
    const cashBefore = (await getFinanceSummary(A.ctx)).cash;
    await expect(reverseExpense(B.ctx, e.id, { reason: "Hostile" }, randomUUID())).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect((await getFinanceSummary(A.ctx)).cash).toBe(cashBefore);
    expect((await listExpenses(A.ctx)).find((x) => x.id === e.id)?.reversedAt).toBeNull();
    const bJournals = await withTenantTransaction(B.tenantId, (tx) => tx.select().from(journals).where(and(eq(journals.tenantId, B.tenantId), eq(journals.referenceType, "REVERSAL"))));
    expect(bJournals).toHaveLength(0);
  });

  it("writes an audit record that carries the reason", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A), randomUUID());
    await reverseExpense(A.ctx, e.id, { reason: "Audited reason" }, randomUUID());
    const rows = await withTenantTransaction(A.tenantId, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.tenantId, A.tenantId), eq(auditLogs.entityId, e.id), eq(auditLogs.action, "expense.reverse"))));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("Audited reason");
  });
});

describe("history and immutability", () => {
  it("listExpenses keeps the reversed expense, flagged with when and why", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A, { amount: "88" }), randomUUID());
    await reverseExpense(A.ctx, e.id, { reason: "Shown in history" }, randomUUID());
    const row = (await listExpenses(A.ctx)).find((x) => x.id === e.id)!;
    expect(row.reversalReason).toBe("Shown in history");
    expect(row.reversedAt).toBeInstanceOf(Date);
    expect(row.amount).toBe("88.0000"); // the original is never altered
  });

  it("the original expense row is untouched by a reversal", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A, { amount: "19.99" }), randomUUID());
    await reverseExpense(A.ctx, e.id, { reason: "Check immutability" }, randomUUID());
    const after = await withTenantTransaction(A.tenantId, (tx) => tx.query.expenses.findFirst({ where: eq(expenses.id, e.id) }));
    expect(after).toMatchObject({ amount: e.amount, categoryId: e.categoryId, expenseDate: e.expenseDate, description: e.description });
  });

  it("the runtime role cannot UPDATE or DELETE a reversal record (RLS append-only)", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A), randomUUID());
    const r = await reverseExpense(A.ctx, e.id, { reason: "Immutable" }, randomUUID());
    const upd = await withTenantTransaction(A.tenantId, (tx) => tx.update(expenseReversals).set({ reason: "tampered" }).where(eq(expenseReversals.id, r.id)).returning());
    const del = await withTenantTransaction(A.tenantId, (tx) => tx.delete(expenseReversals).where(eq(expenseReversals.id, r.id)).returning());
    expect(upd).toHaveLength(0);
    expect(del).toHaveLength(0);
  });

  it("the database itself refuses a second reversal row for one expense, and a reversal-of-a-reversal journal row for one original", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A), randomUUID());
    const r = await reverseExpense(A.ctx, e.id, { reason: "Once" }, randomUUID());
    await expect(withTenantTransaction(A.tenantId, (tx) => tx.insert(expenseReversals).values({ tenantId: A.tenantId, expenseId: e.id, reversalJournalId: r.reversalJournalId, reason: "Twice", operationId: randomUUID() }))).rejects.toThrow();
    const [orig] = await journalsOf(A.tenantId, "EXPENSE", e.id);
    await expect(withTenantTransaction(A.tenantId, (tx) => tx.insert(journals).values({ tenantId: A.tenantId, referenceType: "REVERSAL", referenceId: orig!.id, operationId: randomUUID() }))).rejects.toThrow();
  });

  it("the database refuses a blank reason even if the application were bypassed", async () => {
    const e = await recordExpense(A.ctx, expenseBody(A), randomUUID());
    const [orig] = await journalsOf(A.tenantId, "EXPENSE", e.id);
    await expect(withTenantTransaction(A.tenantId, (tx) => tx.insert(expenseReversals).values({ tenantId: A.tenantId, expenseId: e.id, reversalJournalId: orig!.id, reason: "  ", operationId: randomUUID() }))).rejects.toThrow();
  });
});

describe("permission (seeded presets)", () => {
  const perms = async (key: string) => {
    const role = await db.query.roles.findFirst({ where: (r, { and: a, eq: e, isNull }) => a(isNull(r.tenantId), e(r.key, key)) });
    return resolvePermissions(role!.id);
  };
  it("OWNER and MANAGER hold expenses.reverse; STAFF does not (a correction is not a cashier action)", async () => {
    expect(await perms("OWNER")).toContain("expenses.reverse");
    expect(await perms("MANAGER")).toContain("expenses.reverse");
    expect(await perms("STAFF")).not.toContain("expenses.reverse");
  });
});
