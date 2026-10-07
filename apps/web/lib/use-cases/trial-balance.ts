/**
 * Trial Balance -- 08_ACCOUNTING_ENGINE_SPECIFICATION.md §6.1.
 * Derived from posted journal entries, with an integrity check over the
 * selected period and exact decimal arithmetic.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { accounts, journalEntries, journals, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import type { TenantContext } from "../guard";

export type TrialBalanceFilter = { dateFrom?: string; dateTo?: string };

export type TrialBalanceReport = {
  period: { dateFrom: string | null; dateTo: string | null };
  lines: Array<{ code: string; name: string; type: string; debit: string; credit: string }>;
  totals: { debit: string; credit: string };
};

const toUnits = (value: string): bigint => {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(whole || "0") * 10000n + BigInt(fraction.padEnd(4, "0").slice(0, 4));
  return negative ? -units : units;
};

const fromUnits = (value: bigint): string => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10000n;
  const fraction = (absolute % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
};

export async function getTrialBalance(ctx: TenantContext, filter: TrialBalanceFilter = {}): Promise<TrialBalanceReport> {
  const rows = await withTenantTransaction(ctx.tenantId, (tx) =>
    tx
      .select({
        code: accounts.code,
        name: accounts.name,
        type: accounts.type,
        debit: sql<string>`coalesce(sum(${journalEntries.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalEntries.credit}), 0)`,
      })
      .from(journalEntries)
      .innerJoin(journals, eq(journals.id, journalEntries.journalId))
      .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
      .where(
        and(
          eq(journalEntries.tenantId, ctx.tenantId),
          eq(journals.tenantId, ctx.tenantId),
          eq(accounts.tenantId, ctx.tenantId),
          filter.dateFrom ? gte(journals.postedAt, new Date(`${filter.dateFrom}T00:00:00.000Z`)) : undefined,
          filter.dateTo ? lte(journals.postedAt, new Date(`${filter.dateTo}T23:59:59.999Z`)) : undefined,
        ),
      )
      .groupBy(accounts.code, accounts.name, accounts.type)
      .orderBy(accounts.code),
  );

  const totalDebit = rows.reduce((total, row) => total + toUnits(row.debit), 0n);
  const totalCredit = rows.reduce((total, row) => total + toUnits(row.credit), 0n);
  if (totalDebit !== totalCredit) {
    const details = {
      dateFrom: filter.dateFrom ?? null,
      dateTo: filter.dateTo ?? null,
      totalDebit: fromUnits(totalDebit),
      totalCredit: fromUnits(totalCredit),
    };
    console.error("Accounting integrity incident: trial balance is out of balance", details);
    throw new AppError("UNBALANCED_JOURNAL", "Trial balance does not balance", details);
  }

  return {
    period: { dateFrom: filter.dateFrom ?? null, dateTo: filter.dateTo ?? null },
    lines: rows.map((row) => ({
      code: row.code,
      name: row.name,
      type: row.type,
      debit: fromUnits(toUnits(row.debit)),
      credit: fromUnits(toUnits(row.credit)),
    })),
    totals: { debit: fromUnits(totalDebit), credit: fromUnits(totalCredit) },
  };
}
