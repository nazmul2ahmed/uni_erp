import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, journalEntries, journals, memberships, tenants, users, withTenantTransaction } from "@erp/db";
import type { TenantContext } from "../lib/guard";
import { resolvePermissions, resolveRoleKey } from "../lib/guard";
import { registerOwnerAndTenant } from "../lib/tenant-onboarding";
import { postJournal } from "../lib/accounting";
import { createCustomer } from "../lib/use-cases/customer";
import { createSupplier } from "../lib/use-cases/supplier";
import { closeAccountingPeriod, createManualJournal, createOpeningEntry, listOpeningEntries, reopenAccountingPeriod } from "../lib/use-cases/accounting-admin";
import { getBalanceSheet, getCashFlow, getPayableAging, getReceivableAging } from "../lib/use-cases/accounting-reports";
import { getFinanceSummary, listPayables, listReceivables, recordCustomerPayment, recordSupplierPayment } from "../lib/use-cases/finance";

let tenantId: string;
let userId: string;
let ctx: TenantContext;
let customerId: string;
let supplierId: string;
let openingReceivableId: string;
let openingPayableId: string;
let otherTenantId: string;
let otherUserId: string;
let otherCtx: TenantContext;

async function provision(): Promise<void> {
  const registration = await registerOwnerAndTenant({
    email: `accounting-depth-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: "Accounting Depth",
    businessName: "Accounting Depth",
  });
  tenantId = registration.tenantId;
  userId = registration.userId;
  const membership = await db.query.memberships.findFirst({ where: eq(memberships.id, registration.membershipId) });
  if (!membership) throw new Error("Owner membership was not created");
  ctx = {
    requestId: randomUUID(),
    userId,
    tenantId,
    membershipId: registration.membershipId,
    roleId: membership.roleId,
    storageMode: "SHARED",
    permissions: await resolvePermissions(membership.roleId),
    roleKey: await resolveRoleKey(membership.roleId),
  };
  const otherRegistration = await registerOwnerAndTenant({
    email: `accounting-depth-other-${randomUUID()}@example.test`,
    password: "correct horse battery staple",
    fullName: "Other Accounting Tenant",
    businessName: "Other Accounting Tenant",
  });
  otherTenantId = otherRegistration.tenantId;
  otherUserId = otherRegistration.userId;
  const otherMembership = await db.query.memberships.findFirst({ where: eq(memberships.id, otherRegistration.membershipId) });
  if (!otherMembership) throw new Error("Other owner membership was not created");
  otherCtx = {
    requestId: randomUUID(),
    userId: otherUserId,
    tenantId: otherTenantId,
    membershipId: otherRegistration.membershipId,
    roleId: otherMembership.roleId,
    storageMode: "SHARED",
    permissions: await resolvePermissions(otherMembership.roleId),
    roleKey: await resolveRoleKey(otherMembership.roleId),
  };
}

beforeAll(async () => {
  await provision();
  customerId = (await createCustomer(ctx, { type: "INDIVIDUAL", name: "Opening customer" } as never)).id;
  supplierId = (await createSupplier(ctx, { type: "BUSINESS", name: "Opening supplier" } as never)).id;
  await createOpeningEntry(otherCtx, { entryType: "CASH", amount: "999" }, randomUUID());
}, 90_000);

afterAll(async () => {
  for (const fixture of [{ tenantId, userId }, { tenantId: otherTenantId, userId: otherUserId }]) {
    if (!fixture.tenantId) continue;
    await db.delete(tenants).where(eq(tenants.id, fixture.tenantId));
    if (fixture.userId) await db.delete(users).where(eq(users.id, fixture.userId)).catch(() => undefined);
  }
});

describe("Phase 3 accounting depth", () => {
  it("creates all opening entry types idempotently and keeps party balances operational", async () => {
    const entries = [
      { entryType: "CASH", amount: "100" },
      { entryType: "BANK", amount: "50" },
      { entryType: "STOCK", amount: "80" },
      { entryType: "CAPITAL", amount: "25", accountCode: "1200" },
      { entryType: "CUSTOMER_RECEIVABLE", amount: "120", customerId, dueDate: "2026-01-01" },
      { entryType: "SUPPLIER_PAYABLE", amount: "70", supplierId, dueDate: "2026-01-01" },
    ] as const;
    const created = [];
    for (const entry of entries) {
      const operationId = randomUUID();
      const row = await createOpeningEntry(ctx, entry as never, operationId);
      expect(await createOpeningEntry(ctx, entry as never, operationId)).toMatchObject({ id: row.id });
      created.push(row);
    }
    openingReceivableId = created.find((row) => row.entryType === "CUSTOMER_RECEIVABLE")!.id;
    openingPayableId = created.find((row) => row.entryType === "SUPPLIER_PAYABLE")!.id;

    await expect(createOpeningEntry(ctx, { entryType: "CASH", amount: "101" }, randomUUID()))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    await recordCustomerPayment(ctx, {
      customerId,
      amount: "45",
      method: "CASH",
      allocations: [{ openingBalanceId: openingReceivableId, amount: "45" }],
    }, randomUUID());
    await recordSupplierPayment(ctx, {
      supplierId,
      amount: "20",
      method: "BANK",
      allocations: [{ openingBalanceId: openingPayableId, amount: "20" }],
    }, randomUUID());
    await recordCustomerPayment(ctx, {
      customerId,
      amount: "10",
      method: "CASH",
    }, randomUUID());

    const receivables = await listReceivables(ctx, customerId);
    const payables = await listPayables(ctx, supplierId);
    expect(receivables).toEqual(expect.arrayContaining([expect.objectContaining({ id: openingReceivableId, balance: "65.0000", source: "OPENING_BALANCE" })]));
    expect(payables).toEqual(expect.arrayContaining([expect.objectContaining({ id: openingPayableId, balance: "50.0000", source: "OPENING_BALANCE" })]));
    expect(await getFinanceSummary(ctx)).toMatchObject({ receivables: "65", payables: "50", cash: "155", bank: "30" });
    expect((await getReceivableAging(ctx, new Date().toISOString().slice(0, 10))).total).toBe("65");
    expect((await getPayableAging(ctx, new Date().toISOString().slice(0, 10))).total).toBe("50");
    expect(await listOpeningEntries(ctx)).toHaveLength(6);
    expect(await getFinanceSummary(ctx)).not.toMatchObject({ cash: "999" });
  });

  it("balances manual journals and rejects an unbalanced entry set", async () => {
    const postedAt = new Date().toISOString().slice(0, 10);
    await expect(createManualJournal(ctx, {
      postedAt,
      entries: [{ accountCode: "1000", debit: "10" }, { accountCode: "3000", credit: "9" }],
    }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const journal = await createManualJournal(ctx, {
      description: "Phase 3 test adjustment",
      postedAt,
      entries: [{ accountCode: "1000", debit: "10" }, { accountCode: "3000", credit: "10" }],
    }, randomUUID());
    expect(journal.referenceType).toBe("MANUAL_ADJUSTMENT");
    expect(await createManualJournal(ctx, {
      description: "Phase 3 test adjustment",
      postedAt,
      entries: [{ accountCode: "1000", debit: "10" }, { accountCode: "3000", credit: "10" }],
    }, journal.operationId)).toMatchObject({ id: journal.id });
  });

  it("classifies opening cash as financing and customer/supplier settlements as operating cash flow", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const report = await getCashFlow(ctx, { dateFrom: today, dateTo: today });
    expect(report).toMatchObject({
      operatingActivities: "35",
      investingActivities: "0",
      financingActivities: "160",
      netCashFlow: "195",
    });
  });

  it("computes a balanced balance sheet from ledger balances", async () => {
    const report = await getBalanceSheet(ctx, new Date().toISOString().slice(0, 10));
    expect(report.balanced).toBe(true);
    expect(report.totalAssets).toBe(report.totalLiabilitiesAndEquity);
  });

  it("closes the period to retained earnings, blocks backdated postings, and exactly reverses on reopen", async () => {
    const periodEnd = new Date().toISOString().slice(0, 10);
    const incomeOperationId = randomUUID();
    const incomeJournal = await withTenantTransaction(tenantId, (tx) => postJournal(tx, ctx, {
      referenceType: "TEST_REVENUE",
      referenceId: randomUUID(),
      description: "Period-close test revenue",
      operationId: incomeOperationId,
      postedAt: new Date(`${periodEnd}T12:00:00.000Z`),
      lines: [{ code: "1000", debit: "100" }, { code: "4000", credit: "100" }],
    }));
    await withTenantTransaction(tenantId, (tx) => postJournal(tx, ctx, {
      referenceType: "TEST_EXPENSE",
      referenceId: randomUUID(),
      description: "Period-close test expense",
      operationId: randomUUID(),
      postedAt: new Date(`${periodEnd}T12:00:00.000Z`),
      lines: [{ code: "5900", debit: "20" }, { code: "1000", credit: "20" }],
    }));

    const closeOperationId = randomUUID();
    const closed = await closeAccountingPeriod(ctx, { periodEnd }, closeOperationId);
    expect(closed.closed).toBe(true);
    if (!closed.closed) throw new Error("Expected period to close");
    const closingJournalId = closed.period.closingJournalId!;
    const closeEntries = await withTenantTransaction(tenantId, (tx) =>
      tx.query.journalEntries.findMany({ where: eq(journalEntries.journalId, closingJournalId) }),
    );
    const retainedEarnings = await withTenantTransaction(tenantId, (tx) =>
      tx.query.accounts.findFirst({ where: (row, { and: a, eq: e }) => a(e(row.tenantId, tenantId), e(row.code, "3100")) }),
    );
    expect(retainedEarnings).toBeTruthy();
    const retainedLine = closeEntries.find((entry) => entry.accountId === retainedEarnings!.id);
    expect(retainedLine?.credit).toBe("80.0000");
    expect(await closeAccountingPeriod(ctx, { periodEnd }, closeOperationId)).toMatchObject({ closed: true, period: { id: closed.period.id } });
    const nextDate = new Date(`${periodEnd}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    await expect(closeAccountingPeriod(ctx, { periodEnd: nextDate.toISOString().slice(0, 10) }, closeOperationId))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    await expect(withTenantTransaction(tenantId, (tx) => postJournal(tx, ctx, {
      referenceType: "TEST_LATE",
      referenceId: randomUUID(),
      description: "Must be blocked",
      operationId: randomUUID(),
      postedAt: new Date(`${periodEnd}T12:00:00.000Z`),
      lines: [{ code: "1000", debit: "1" }, { code: "3000", credit: "1" }],
    }))).rejects.toMatchObject({ code: "PERIOD_LOCKED" });

    const reopenOperationId = randomUUID();
    const reopened = await reopenAccountingPeriod(ctx, closed.period.id, reopenOperationId);
    expect(reopened.period.status).toBe("OPEN");
    const reversalEntries = await withTenantTransaction(tenantId, (tx) =>
      tx.query.journalEntries.findMany({ where: eq(journalEntries.journalId, reopened.reversalJournalId!) }),
    );
    expect(reversalEntries).toHaveLength(closeEntries.length);
    expect(reversalEntries.map((entry) => [entry.accountId, entry.debit, entry.credit]).sort()).toEqual(
      closeEntries.map((entry) => [entry.accountId, entry.credit, entry.debit]).sort(),
    );
    const replay = await reopenAccountingPeriod(ctx, closed.period.id, reopenOperationId);
    expect(replay.period.status).toBe("OPEN");
    expect(await getFinanceSummary(ctx)).toBeTruthy();
    expect(incomeJournal).toBeTruthy();
  });
});
