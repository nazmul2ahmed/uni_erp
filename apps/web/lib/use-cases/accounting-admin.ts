import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import {
  accounts,
  accountingPeriodEvents,
  accountingPeriods,
  customers,
  journalEntries,
  journals,
  openingBalances,
  purchases,
  sales,
  suppliers,
  withTenantTransaction,
} from "@erp/db";
import { AppError } from "@erp/shared";
import type { OpeningEntryInput } from "@erp/validation";
import type { Database } from "@erp/db";
import type { TenantContext } from "../guard";
import { assertAccountingPeriodOpen, postJournal, postReversalJournal } from "../accounting";
import { recordAudit } from "../audit";

const units = (value: string) => {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole || "0") * 10000n + BigInt(fraction.padEnd(4, "0").slice(0, 4));
};
const decimal = (value: bigint) => {
  const whole = value / 10000n;
  const fraction = (value % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
};
const utcDate = (value: string) => new Date(`${value}T23:59:59.999Z`);

function openingReference(ctx: TenantContext, input: OpeningEntryInput): { referenceId: string; accountCode: string | null } {
  switch (input.entryType) {
    case "CUSTOMER_RECEIVABLE": return { referenceId: input.customerId, accountCode: null };
    case "SUPPLIER_PAYABLE": return { referenceId: input.supplierId, accountCode: null };
    case "CAPITAL": return { referenceId: ctx.tenantId, accountCode: input.accountCode };
    default: return { referenceId: ctx.tenantId, accountCode: null };
  }
}

function sameOpeningPayload(
  row: typeof openingBalances.$inferSelect,
  input: OpeningEntryInput,
  referenceId: string,
  accountCode: string | null,
) {
  return row.entryType === input.entryType
    && row.referenceId === referenceId
    && units(row.amount) === units(input.amount)
    && row.accountCode === accountCode
    && row.customerId === ("customerId" in input ? input.customerId : null)
    && row.supplierId === ("supplierId" in input ? input.supplierId : null)
    && row.dueDate === ("dueDate" in input ? input.dueDate ?? null : null);
}

export async function createOpeningEntry(ctx: TenantContext, input: OpeningEntryInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId}, 0))`);
    const { referenceId, accountCode } = openingReference(ctx, input);
    const operationReplay = await tx.query.openingBalances.findFirst({
      where: and(eq(openingBalances.tenantId, ctx.tenantId), eq(openingBalances.operationId, operationId)),
    });
    if (operationReplay) {
      if (sameOpeningPayload(operationReplay, input, referenceId, accountCode)) return operationReplay;
      throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for another opening balance");
    }
    const journalReplay = await tx.query.journals.findFirst({
      where: and(eq(journals.tenantId, ctx.tenantId), eq(journals.operationId, operationId)),
    });
    if (journalReplay) throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for another journal");
    const existing = await tx.query.openingBalances.findFirst({
      where: and(
        eq(openingBalances.tenantId, ctx.tenantId),
        eq(openingBalances.entryType, input.entryType),
        eq(openingBalances.referenceId, referenceId),
      ),
    });
    if (existing) {
      if (sameOpeningPayload(existing, input, referenceId, accountCode)) return existing;
      throw new AppError("IDEMPOTENCY_KEY_REUSED", "An opening balance already exists for this account or party");
    }

    let customerId: string | null = null;
    let supplierId: string | null = null;
    if (input.entryType === "CUSTOMER_RECEIVABLE") {
      const party = await tx.query.customers.findFirst({ where: and(eq(customers.id, input.customerId), eq(customers.tenantId, ctx.tenantId), eq(customers.isActive, true)) });
      if (!party) throw new AppError("RESOURCE_NOT_FOUND", "Customer not found or inactive");
      customerId = party.id;
    }
    if (input.entryType === "SUPPLIER_PAYABLE") {
      const party = await tx.query.suppliers.findFirst({ where: and(eq(suppliers.id, input.supplierId), eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.isActive, true)) });
      if (!party) throw new AppError("RESOURCE_NOT_FOUND", "Supplier not found or inactive");
      supplierId = party.id;
    }
    if (input.entryType === "CAPITAL") {
      const account = await tx.query.accounts.findFirst({ where: and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.code, input.accountCode), eq(accounts.isActive, true)) });
      if (!account || account.type !== "ASSET") {
        throw new AppError("VALIDATION_FAILED", "Choose an active asset account for the opening capital entry", { field: "accountCode" });
      }
    }

    const id = crypto.randomUUID();
    const postedAt = new Date();
    const debitCode = input.entryType === "CASH" ? "1000"
      : input.entryType === "BANK" ? "1010"
        : input.entryType === "STOCK" ? "1200"
          : input.entryType === "CUSTOMER_RECEIVABLE" ? "1100"
            : input.entryType === "SUPPLIER_PAYABLE" ? "3000" : accountCode!;
    const creditCode = input.entryType === "SUPPLIER_PAYABLE" ? "2000" : "3000";
    const journal = await postJournal(tx, ctx, {
      referenceType: "OPENING_ENTRY",
      referenceId: id,
      description: `Opening ${input.entryType.toLowerCase().replaceAll("_", " ")}`,
      operationId,
      postedAt,
      lines: [{ code: debitCode, debit: input.amount }, { code: creditCode, credit: input.amount }],
    });
    const [record] = await tx.insert(openingBalances).values({
      id,
      tenantId: ctx.tenantId,
      entryType: input.entryType,
      referenceId,
      customerId,
      supplierId,
      accountCode,
      amount: input.amount,
      paidAmount: "0",
      balance: input.amount,
      status: "OPEN",
      dueDate: "dueDate" in input ? input.dueDate ?? null : null,
      journalId: journal.id,
      operationId,
      createdBy: ctx.userId,
    }).returning();
    if (!record) throw new AppError("INTERNAL_ERROR", "Unable to save opening balance");
    await recordAudit(tx, ctx, {
      action: "accounting.opening_entry",
      entityType: "OPENING_BALANCE",
      entityId: id,
      after: { entryType: input.entryType, amount: input.amount, referenceId, accountCode },
    });
    return record;
  });
}

export async function listOpeningEntries(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, (tx) =>
    tx.query.openingBalances.findMany({
      where: eq(openingBalances.tenantId, ctx.tenantId),
      orderBy: [desc(openingBalances.createdAt)],
    }),
  );
}

export async function createManualJournal(
  ctx: TenantContext,
  input: { description?: string; postedAt: string; entries: Array<{ accountCode: string; debit?: string; credit?: string }> },
  operationId: string,
) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const existing = await tx.query.journals.findFirst({
      where: and(eq(journals.tenantId, ctx.tenantId), eq(journals.operationId, operationId)),
    });
    if (existing) {
      if (existing.referenceType !== "MANUAL_ADJUSTMENT" || existing.description !== (input.description || "Manual journal adjustment")) {
        throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for another journal");
      }
      const lines = await tx.select({
        accountId: journalEntries.accountId,
        debit: journalEntries.debit,
        credit: journalEntries.credit,
      }).from(journalEntries)
        .innerJoin(journals, eq(journals.id, journalEntries.journalId))
        .where(and(eq(journals.tenantId, ctx.tenantId), eq(journals.id, existing.id)));
      const accountsById = new Map((await tx.query.accounts.findMany({ where: eq(accounts.tenantId, ctx.tenantId) })).map((row) => [row.id, row.code]));
        const expected = input.entries.map((line) => `${line.accountCode}:${units(line.debit ?? "0")}:${units(line.credit ?? "0")}`).sort();
        const actual = lines.map((line) => `${accountsById.get(line.accountId)}:${units(line.debit)}:${units(line.credit)}`).sort();
      if (existing.postedAt.toISOString().slice(0, 10) !== input.postedAt || expected.join("|") !== actual.join("|")) {
        throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with a different journal payload");
      }
      return existing;
    }
    const debit = input.entries.reduce((total, line) => total + units(line.debit ?? "0"), 0n);
    const credit = input.entries.reduce((total, line) => total + units(line.credit ?? "0"), 0n);
    if (debit !== credit) {
      throw new AppError("VALIDATION_FAILED", "Manual journal debits must equal credits", { totalDebit: decimal(debit), totalCredit: decimal(credit) });
    }
    const uniqueCodes = [...new Set(input.entries.map((line) => line.accountCode))];
    const tenantAccounts = await tx.query.accounts.findMany({
      where: and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.isActive, true)),
    });
    const byCode = new Map(tenantAccounts.map((account) => [account.code, account]));
    for (const code of uniqueCodes) {
      if (!byCode.has(code)) throw new AppError("RESOURCE_NOT_FOUND", `Active account ${code} not found`);
    }
    const postedAt = new Date(`${input.postedAt}T12:00:00.000Z`);
    await assertAccountingPeriodOpen(tx, ctx.tenantId, postedAt);
    const journal = await postJournal(tx, ctx, {
      referenceType: "MANUAL_ADJUSTMENT",
      referenceId: operationId,
      description: input.description || "Manual journal adjustment",
      operationId,
      postedAt,
      lines: input.entries.map(({ accountCode, debit: lineDebit, credit: lineCredit }) => ({ code: accountCode, debit: lineDebit, credit: lineCredit })),
    });
    await recordAudit(tx, ctx, {
      action: "accounting.manual_journal",
      entityType: "JOURNAL",
      entityId: journal.id,
      after: { description: input.description || "Manual journal adjustment", postedAt: input.postedAt, entries: input.entries },
      reason: "Manual accounting adjustment",
    });
    return journal;
  });
}

async function periodDraftCounts(tx: Database, tenantId: string, start: string, end: string) {
  const [draftSales, draftPurchases] = await Promise.all([
    tx.select({ count: sql<number>`count(*)::int` }).from(sales).where(and(eq(sales.tenantId, tenantId), eq(sales.status, "DRAFT"), gte(sales.saleDate, new Date(`${start}T00:00:00.000Z`)), lte(sales.saleDate, utcDate(end)))),
    tx.select({ count: sql<number>`count(*)::int` }).from(purchases).where(and(eq(purchases.tenantId, tenantId), eq(purchases.status, "DRAFT"), gte(purchases.purchaseDate, new Date(`${start}T00:00:00.000Z`)), lte(purchases.purchaseDate, utcDate(end)))),
  ]);
  return { sales: draftSales[0]?.count ?? 0, purchases: draftPurchases[0]?.count ?? 0 };
}

export async function listAccountingPeriods(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, (tx) =>
    tx.query.accountingPeriods.findMany({ where: eq(accountingPeriods.tenantId, ctx.tenantId), orderBy: [desc(accountingPeriods.periodEnd)] }),
  );
}

export async function closeAccountingPeriod(
  ctx: TenantContext,
  input: { periodEnd: string; confirmDrafts?: boolean },
  operationId: string,
) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId}, 0))`);
    const replay = await tx.query.accountingPeriodEvents.findFirst({
      where: and(eq(accountingPeriodEvents.tenantId, ctx.tenantId), eq(accountingPeriodEvents.operationId, operationId)),
    });
    if (replay) {
      if (replay.action !== "CLOSE") throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used to reopen a period");
      const period = await tx.query.accountingPeriods.findFirst({ where: eq(accountingPeriods.id, replay.periodId) });
      if (!period) throw new AppError("INTERNAL_ERROR", "Accounting period event has no period");
      if (period.periodEnd !== input.periodEnd) throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused for a different period end");
      return { closed: period.status === "CLOSED", period, draftCounts: { sales: 0, purchases: 0 } };
    }
    const journalReplay = await tx.query.journals.findFirst({
      where: and(eq(journals.tenantId, ctx.tenantId), eq(journals.operationId, operationId)),
    });
    if (journalReplay) throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for another journal");

    const latest = await tx.query.accountingPeriods.findFirst({
      where: and(eq(accountingPeriods.tenantId, ctx.tenantId), eq(accountingPeriods.status, "CLOSED")),
      orderBy: [desc(accountingPeriods.periodEnd)],
    });
    const overlapping = await tx.query.accountingPeriods.findFirst({
      where: and(
        eq(accountingPeriods.tenantId, ctx.tenantId),
        eq(accountingPeriods.status, "CLOSED"),
        lte(accountingPeriods.periodStart, input.periodEnd),
      ),
      orderBy: [asc(accountingPeriods.periodStart)],
    });
    const journalsInTenant = await tx.select({ first: sql<string | null>`min(${journals.postedAt})` })
      .from(journals)
      .where(eq(journals.tenantId, ctx.tenantId));
    const firstJournalDate = journalsInTenant[0]?.first;
    if (!firstJournalDate) throw new AppError("VALIDATION_FAILED", "Cannot close a period before the tenant has a posted journal");
    const periodStart = latest
      ? (() => {
          const next = new Date(`${latest.periodEnd}T00:00:00.000Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          return next.toISOString().slice(0, 10);
        })()
      : new Date(firstJournalDate).toISOString().slice(0, 10);
    if (input.periodEnd < periodStart) throw new AppError("VALIDATION_FAILED", "Period end must be on or after the next open accounting date", { periodStart, periodEnd: input.periodEnd });
    if (overlapping && overlapping.periodStart < periodStart && overlapping.periodEnd >= periodStart) {
      throw new AppError("VALIDATION_FAILED", "A closed accounting period already overlaps the requested range", { periodId: overlapping.id });
    }

    const draftCounts = await periodDraftCounts(tx, ctx.tenantId, periodStart, input.periodEnd);
    if ((draftCounts.sales > 0 || draftCounts.purchases > 0) && !input.confirmDrafts) {
      return { closed: false as const, draftCounts, periodStart, periodEnd: input.periodEnd };
    }

    const balances = await tx
      .select({
        code: accounts.code,
        type: accounts.type,
        debit: sql<string>`coalesce(sum(${journalEntries.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalEntries.credit}), 0)`,
      })
      .from(journalEntries)
      .innerJoin(journals, eq(journals.id, journalEntries.journalId))
      .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
      .where(and(
        eq(journalEntries.tenantId, ctx.tenantId),
        eq(journals.tenantId, ctx.tenantId),
        eq(accounts.tenantId, ctx.tenantId),
        inArray(accounts.type, ["INCOME", "EXPENSE"]),
        gte(journals.postedAt, new Date(`${periodStart}T00:00:00.000Z`)),
        lte(journals.postedAt, utcDate(input.periodEnd)),
        ne(journals.referenceType, "ACCOUNTING_PERIOD_CLOSE"),
      ))
      .groupBy(accounts.code, accounts.type);
    const closeLines: Array<{ code: string; debit?: string; credit?: string }> = [];
    let earnings = 0n;
    for (const row of balances) {
      const debit = units(row.debit);
      const credit = units(row.credit);
      const balance = row.type === "INCOME" ? credit - debit : debit - credit;
      earnings += row.type === "INCOME" ? balance : -balance;
      if (balance === 0n) continue;
      if (row.type === "INCOME") closeLines.push(balance > 0n ? { code: row.code, debit: decimal(balance) } : { code: row.code, credit: decimal(-balance) });
      else closeLines.push(balance > 0n ? { code: row.code, credit: decimal(balance) } : { code: row.code, debit: decimal(-balance) });
    }
    if (earnings !== 0n) closeLines.push(earnings > 0n ? { code: "3100", credit: decimal(earnings) } : { code: "3100", debit: decimal(-earnings) });
    const periodId = crypto.randomUUID();
    const closingJournal = closeLines.length > 0
      ? await postJournal(tx, ctx, {
          referenceType: "ACCOUNTING_PERIOD_CLOSE",
          referenceId: periodId,
          description: `Close accounting period ${periodStart} to ${input.periodEnd}`,
          operationId,
          postedAt: utcDate(input.periodEnd),
          lines: closeLines,
        })
      : null;
    const existingOpenPeriod = await tx.query.accountingPeriods.findFirst({
      where: and(
        eq(accountingPeriods.tenantId, ctx.tenantId),
        eq(accountingPeriods.periodStart, periodStart),
        eq(accountingPeriods.periodEnd, input.periodEnd),
        eq(accountingPeriods.status, "OPEN"),
      ),
    });
    const [period] = existingOpenPeriod
      ? await tx.update(accountingPeriods).set({
          status: "CLOSED",
          closingJournalId: closingJournal?.id ?? null,
          closedAt: new Date(),
          closedBy: ctx.userId,
        }).where(eq(accountingPeriods.id, existingOpenPeriod.id)).returning()
      : await tx.insert(accountingPeriods).values({
          id: periodId,
          tenantId: ctx.tenantId,
          periodStart,
          periodEnd: input.periodEnd,
          status: "CLOSED",
          closingJournalId: closingJournal?.id ?? null,
          closedAt: new Date(),
          closedBy: ctx.userId,
        }).returning();
    if (!period) throw new AppError("INTERNAL_ERROR", "Unable to persist accounting period");
    await tx.insert(accountingPeriodEvents).values({
      tenantId: ctx.tenantId,
      periodId: period.id,
      action: "CLOSE",
      operationId,
      journalId: closingJournal?.id ?? null,
      createdBy: ctx.userId,
    });
    await recordAudit(tx, ctx, {
      action: "accounting.period.close",
      entityType: "ACCOUNTING_PERIOD",
      entityId: period.id,
      after: { periodStart, periodEnd: input.periodEnd, netProfit: decimal(earnings), closingJournalId: closingJournal?.id ?? null, draftCounts },
    });
    return { closed: true as const, period, draftCounts };
  });
}

export async function reopenAccountingPeriod(ctx: TenantContext, periodId: string, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId}, 0))`);
    const replay = await tx.query.accountingPeriodEvents.findFirst({
      where: and(eq(accountingPeriodEvents.tenantId, ctx.tenantId), eq(accountingPeriodEvents.operationId, operationId)),
    });
    if (replay) {
      if (replay.action !== "REOPEN") throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used to close a period");
      if (replay.periodId !== periodId) throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused for another accounting period");
      const period = await tx.query.accountingPeriods.findFirst({ where: eq(accountingPeriods.id, replay.periodId) });
      if (!period) throw new AppError("INTERNAL_ERROR", "Accounting period event has no period");
      return { period, reversalJournalId: replay.journalId };
    }
    const journalReplay = await tx.query.journals.findFirst({
      where: and(eq(journals.tenantId, ctx.tenantId), eq(journals.operationId, operationId)),
    });
    if (journalReplay) throw new AppError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for another journal");
    const [period] = await tx.select().from(accountingPeriods)
      .where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.tenantId, ctx.tenantId)))
      .for("update");
    if (!period) throw new AppError("RESOURCE_NOT_FOUND", "Accounting period not found");
    if (period.status !== "CLOSED") {
      throw new AppError("VALIDATION_FAILED", "Only a closed period can be reopened");
    }
    const laterClosed = await tx.query.accountingPeriods.findFirst({
      where: and(
        eq(accountingPeriods.tenantId, ctx.tenantId),
        eq(accountingPeriods.status, "CLOSED"),
        sql`${accountingPeriods.periodStart} > ${period.periodStart}::date`,
      ),
    });
    if (laterClosed) throw new AppError("VALIDATION_FAILED", "Reopen periods in reverse chronological order", { laterPeriodId: laterClosed.id });
    await tx.update(accountingPeriods).set({ status: "OPEN", closedAt: null, closedBy: null }).where(eq(accountingPeriods.id, period.id));
    const reversal = period.closingJournalId
      ? await postReversalJournal(tx, ctx, {
          originalJournalId: period.closingJournalId,
          operationId,
          reason: "Accounting period reopened",
          postedAt: utcDate(period.periodEnd),
        })
      : null;
    await tx.insert(accountingPeriodEvents).values({
      tenantId: ctx.tenantId,
      periodId: period.id,
      action: "REOPEN",
      operationId,
      journalId: reversal?.id ?? null,
      createdBy: ctx.userId,
    });
    await recordAudit(tx, ctx, {
      action: "accounting.period.reopen",
      entityType: "ACCOUNTING_PERIOD",
      entityId: period.id,
      before: { status: "CLOSED", closingJournalId: period.closingJournalId },
      after: { status: "OPEN", reversalJournalId: reversal?.id ?? null },
      reason: "Accounting period reopened and closing journal reversed",
    });
    return { period: { ...period, status: "OPEN" as const, closedAt: null, closedBy: null }, reversalJournalId: reversal?.id ?? null };
  });
}
