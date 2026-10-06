/**
 * Profit & Loss -- 08_ACCOUNTING_ENGINE_SPECIFICATION.md s6.2, Decision ACC-006.
 *
 *   Revenue            = INCOME accounts,  credit - debit
 *   COGS               = account 5000,     debit - credit
 *   Gross Profit       = Total Revenue - COGS
 *   Operating Expenses = every OTHER EXPENSE account (incl. Discount Given
 *                        5100, per 08 s3.5 / s6.2), debit - credit
 *   Net Profit         = Gross Profit - Total Operating Expenses
 *
 * Derived ONLY from posted journal entries within [dateFrom, dateTo] on
 * `journals.posted_at` -- never from today's item-master price or from
 * sales/purchase documents (Cost & Profit Rule: historical cost is the
 * snapshot already carried by the COGS journal). Reversals/returns are
 * ordinary opposite-sign journal lines, so they net out with no special case.
 *
 * This is the SINGLE implementation of the P&L rule: the dashboard's Profit
 * Snapshot widget and the future GET /api/accounting/profit-and-loss route
 * (11 s14) both call it -- no parallel calculation anywhere.
 *
 * All arithmetic is exact (SQL numeric -> bigint 1e-4 units); no floats.
 */
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { accounts, journalEntries, journals, withTenantTransaction } from "@erp/db";
import type { TenantContext } from "../guard";

export type ProfitLossFilter = { dateFrom?: string; dateTo?: string };

export type ProfitLossLine = { code: string; name: string; amount: string };

export type ProfitLossReport = {
  period: { dateFrom: string | null; dateTo: string | null };
  revenue: { lines: ProfitLossLine[]; total: string };
  cogs: { total: string };
  grossProfit: string;
  operatingExpenses: { lines: ProfitLossLine[]; total: string };
  netProfit: string;
};

/** 08 s3.5: Cost of Goods Sold. Every other EXPENSE account is an operating expense. */
const COGS_ACCOUNT_CODE = "5000";

const toUnits = (value: string): bigint => {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(whole || "0") * 10000n + BigInt(fraction.padEnd(4, "0").slice(0, 4));
  return negative ? -units : units;
};

const fromUnits = (value: bigint): string => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10000n;
  const fraction = (abs % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction ? `${whole}.${fraction}` : whole.toString()}`;
};

const sum = (values: bigint[]): bigint => values.reduce((total, v) => total + v, 0n);

export async function getProfitAndLoss(ctx: TenantContext, filter: ProfitLossFilter = {}): Promise<ProfitLossReport> {
  const rows = await withTenantTransaction(ctx.tenantId, async (tx) =>
    tx
      .select({
        code: accounts.code,
        name: accounts.name,
        type: accounts.type,
        debit: sql<string>`coalesce(sum(${journalEntries.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalEntries.credit}), 0)`,
      })
      .from(journalEntries)
      .innerJoin(journals, eq(journalEntries.journalId, journals.id))
      .innerJoin(accounts, eq(journalEntries.accountId, accounts.id))
      .where(
        and(
          eq(journalEntries.tenantId, ctx.tenantId),
          eq(journals.tenantId, ctx.tenantId),
          eq(accounts.tenantId, ctx.tenantId),
          sql`${accounts.type} in ('INCOME', 'EXPENSE')`,
          filter.dateFrom ? gte(journals.postedAt, new Date(filter.dateFrom)) : undefined,
          filter.dateTo ? lte(journals.postedAt, new Date(`${filter.dateTo}T23:59:59.999Z`)) : undefined,
        ),
      )
      .groupBy(accounts.code, accounts.name, accounts.type)
      .orderBy(accounts.code),
  );

  const revenueLines = rows
    .filter((row) => row.type === "INCOME")
    .map((row) => ({ code: row.code, name: row.name, units: toUnits(row.credit) - toUnits(row.debit) }));
  const expenseRows = rows
    .filter((row) => row.type === "EXPENSE")
    .map((row) => ({ code: row.code, name: row.name, units: toUnits(row.debit) - toUnits(row.credit) }));

  const cogsUnits = sum(expenseRows.filter((row) => row.code === COGS_ACCOUNT_CODE).map((row) => row.units));
  const opexRows = expenseRows.filter((row) => row.code !== COGS_ACCOUNT_CODE);

  const revenueTotal = sum(revenueLines.map((row) => row.units));
  const opexTotal = sum(opexRows.map((row) => row.units));
  const grossProfit = revenueTotal - cogsUnits;
  const toLine = (row: { code: string; name: string; units: bigint }): ProfitLossLine => ({ code: row.code, name: row.name, amount: fromUnits(row.units) });

  return {
    period: { dateFrom: filter.dateFrom ?? null, dateTo: filter.dateTo ?? null },
    revenue: { lines: revenueLines.map(toLine), total: fromUnits(revenueTotal) },
    cogs: { total: fromUnits(cogsUnits) },
    grossProfit: fromUnits(grossProfit),
    operatingExpenses: { lines: opexRows.map(toLine), total: fromUnits(opexTotal) },
    netProfit: fromUnits(grossProfit - opexTotal),
  };
}
