import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  accounts,
  accountingPeriods,
  customers,
  journalEntries,
  journals,
  openingBalances,
  payables,
  purchases,
  receivables,
  sales,
  suppliers,
  withTenantTransaction,
} from "@erp/db";
import { AppError } from "@erp/shared";
import type { TenantContext } from "../guard";
import { getProfitAndLoss } from "./profit-loss";

const units = (value: string) => {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const amount = BigInt(whole || "0") * 10000n + BigInt(fraction.padEnd(4, "0").slice(0, 4));
  return negative ? -amount : amount;
};

const decimal = (value: bigint) => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10000n;
  const fraction = (absolute % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
};

const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
const endOfDay = (date: string) => new Date(`${date}T23:59:59.999Z`);

export async function getBalanceSheet(ctx: TenantContext, asOfDate: string): Promise<{
  asOfDate: string;
  assets: { lines: Array<{ code: string; name: string; amount: string }>; total: string };
  liabilities: { lines: Array<{ code: string; name: string; amount: string }>; total: string };
  equity: { lines: Array<{ code: string; name: string; amount: string }>; currentEarnings: string; total: string };
  totalAssets: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}> {
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
      .where(and(
        eq(journalEntries.tenantId, ctx.tenantId),
        eq(journals.tenantId, ctx.tenantId),
        eq(accounts.tenantId, ctx.tenantId),
        inArray(accounts.type, ["ASSET", "LIABILITY", "EQUITY"]),
        lte(journals.postedAt, endOfDay(asOfDate)),
      ))
      .groupBy(accounts.code, accounts.name, accounts.type)
      .orderBy(accounts.code),
  );

  const lineFor = (row: typeof rows[number]) => ({
    code: row.code,
    name: row.name,
    amount: decimal(row.type === "ASSET" ? units(row.debit) - units(row.credit) : units(row.credit) - units(row.debit)),
  });
  const assets = rows.filter((row) => row.type === "ASSET").map(lineFor);
  const liabilities = rows.filter((row) => row.type === "LIABILITY").map(lineFor);
  const equity = rows.filter((row) => row.type === "EQUITY").map(lineFor);

  const lastClosedPeriod = await withTenantTransaction(ctx.tenantId, (tx) =>
    tx.query.accountingPeriods.findFirst({
      where: and(eq(accountingPeriods.tenantId, ctx.tenantId), eq(accountingPeriods.status, "CLOSED"), lte(accountingPeriods.periodEnd, asOfDate)),
      orderBy: (period, { desc }) => [desc(period.periodEnd)],
    }),
  );
  const earningsFrom = lastClosedPeriod
    ? (() => {
        const next = new Date(`${lastClosedPeriod.periodEnd}T00:00:00.000Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        return next.toISOString().slice(0, 10);
      })()
    : undefined;
  const earnings = await getProfitAndLoss(ctx, { dateFrom: earningsFrom, dateTo: asOfDate });
  const assetTotal = sum(assets.map((line) => units(line.amount)));
  const liabilityTotal = sum(liabilities.map((line) => units(line.amount)));
  const equityTotal = sum(equity.map((line) => units(line.amount))) + units(earnings.netProfit);
  const balanceCheck = assetTotal === liabilityTotal + equityTotal;
  if (!balanceCheck) {
    const details = {
      asOfDate,
      totalAssets: decimal(assetTotal),
      totalLiabilitiesAndEquity: decimal(liabilityTotal + equityTotal),
    };
    console.error("Accounting integrity incident: balance sheet is out of balance", details);
    throw new AppError("UNBALANCED_JOURNAL", "Balance sheet does not balance", details);
  }
  return {
    asOfDate,
    assets: { lines: assets, total: decimal(assetTotal) },
    liabilities: { lines: liabilities, total: decimal(liabilityTotal) },
    equity: { lines: equity, currentEarnings: earnings.netProfit, total: decimal(equityTotal) },
    totalAssets: decimal(assetTotal),
    totalLiabilitiesAndEquity: decimal(liabilityTotal + equityTotal),
    balanced: balanceCheck,
  };
}

export async function getCashFlow(ctx: TenantContext, filter: { dateFrom?: string; dateTo?: string }) {
  const rows = await withTenantTransaction(ctx.tenantId, (tx) =>
    tx
      .select({
        journalId: journals.id,
        referenceType: journals.referenceType,
        code: accounts.code,
        type: accounts.type,
        debit: journalEntries.debit,
        credit: journalEntries.credit,
      })
      .from(journalEntries)
      .innerJoin(journals, eq(journals.id, journalEntries.journalId))
      .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
      .where(and(
        eq(journalEntries.tenantId, ctx.tenantId),
        eq(journals.tenantId, ctx.tenantId),
        eq(accounts.tenantId, ctx.tenantId),
        filter.dateFrom ? gte(journals.postedAt, new Date(`${filter.dateFrom}T00:00:00.000Z`)) : undefined,
        filter.dateTo ? lte(journals.postedAt, endOfDay(filter.dateTo)) : undefined,
      )),
  );
  const byJournal = new Map<string, typeof rows>();
  for (const row of rows) byJournal.set(row.journalId, [...(byJournal.get(row.journalId) ?? []), row]);

  let operating = 0n;
  let financing = 0n;
  for (const journalRows of byJournal.values()) {
    const cashRows = journalRows.filter((row) => row.code === "1000" || row.code === "1010");
    if (cashRows.length === 0) continue;
    const movement = sum(cashRows.map((row) => units(row.debit) - units(row.credit)));
    const counterpartCodes = new Set(journalRows.filter((row) => row.code !== "1000" && row.code !== "1010").map((row) => row.code));
    if (journalRows[0]?.referenceType === "OPENING_ENTRY" || (journalRows[0]?.referenceType === "MANUAL_ADJUSTMENT" && (counterpartCodes.has("3000") || counterpartCodes.has("3200")))) financing += movement;
    else operating += movement;
  }
  const investing = 0n;
  return {
    period: { dateFrom: filter.dateFrom ?? null, dateTo: filter.dateTo ?? null },
    operatingActivities: decimal(operating),
    investingActivities: decimal(investing),
    financingActivities: decimal(financing),
    netCashFlow: decimal(operating + investing + financing),
  };
}

export type AgingBucket = "CURRENT" | "DAYS_1_TO_30" | "DAYS_31_TO_60" | "DAYS_61_TO_90" | "OVER_90";
type AgingRow = { partyName: string; source: string; balance: string; dueDate: string | null; basisDate: string; kind: "SALE" | "PURCHASE" | "OPENING" };

function ageRows(rows: AgingRow[], asOfDate: string) {
  const asOf = Date.parse(`${asOfDate}T00:00:00.000Z`);
  const buckets: Record<AgingBucket, bigint> = {
    CURRENT: 0n,
    DAYS_1_TO_30: 0n,
    DAYS_31_TO_60: 0n,
    DAYS_61_TO_90: 0n,
    OVER_90: 0n,
  };
  const details = rows.map((row) => {
    const basisDate = row.dueDate ?? row.basisDate;
    const ageDays = Math.max(0, Math.floor((asOf - Date.parse(`${basisDate}T00:00:00.000Z`)) / 86_400_000));
    const bucket: AgingBucket = ageDays === 0 ? "CURRENT"
      : ageDays <= 30 ? "DAYS_1_TO_30"
        : ageDays <= 60 ? "DAYS_31_TO_60"
          : ageDays <= 90 ? "DAYS_61_TO_90" : "OVER_90";
    buckets[bucket] += units(row.balance);
    return { ...row, bucket, ageDays };
  });
  return {
    asOfDate,
    buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, decimal(value)])) as Record<AgingBucket, string>,
    total: decimal(sum(Object.values(buckets))),
    rows: details,
  };
}

export async function getReceivableAging(ctx: TenantContext, asOfDate: string) {
  const [invoices, openings] = await withTenantTransaction(ctx.tenantId, async (tx) => Promise.all([
    tx.select({
      partyName: customers.name,
      source: sales.invoiceNumber,
      balance: receivables.balance,
      dueDate: receivables.dueDate,
      basisDate: sql<string>`to_char(coalesce(${sales.saleDate}, ${receivables.createdAt}), 'YYYY-MM-DD')`,
    })
      .from(receivables)
      .innerJoin(customers, eq(customers.id, receivables.customerId))
      .leftJoin(sales, eq(sales.id, receivables.saleId))
      .where(and(eq(receivables.tenantId, ctx.tenantId), eq(receivables.partyType, "CUSTOMER"), inArray(receivables.status, ["OPEN", "PARTIAL"]))),
    tx.select({
      partyName: customers.name,
      source: sql<string>`'Opening balance'`,
      balance: openingBalances.balance,
      dueDate: openingBalances.dueDate,
      basisDate: sql<string>`to_char(${openingBalances.createdAt}, 'YYYY-MM-DD')`,
    })
      .from(openingBalances)
      .innerJoin(customers, eq(customers.id, openingBalances.customerId))
      .where(and(eq(openingBalances.tenantId, ctx.tenantId), eq(openingBalances.entryType, "CUSTOMER_RECEIVABLE"), inArray(openingBalances.status, ["OPEN", "PARTIAL"]))),
  ]));
  return ageRows([
    ...invoices.map((row) => ({ ...row, source: row.source ?? "Sale", kind: "SALE" as const })),
    ...openings.map((row) => ({ ...row, kind: "OPENING" as const })),
  ], asOfDate);
}

export async function getPayableAging(ctx: TenantContext, asOfDate: string) {
  const [invoices, openings] = await withTenantTransaction(ctx.tenantId, async (tx) => Promise.all([
    tx.select({
      partyName: suppliers.name,
      source: purchases.purchaseNumber,
      balance: payables.balance,
      dueDate: payables.dueDate,
      basisDate: sql<string>`to_char(coalesce(${purchases.purchaseDate}, ${payables.createdAt}), 'YYYY-MM-DD')`,
    })
      .from(payables)
      .innerJoin(suppliers, eq(suppliers.id, payables.supplierId))
      .leftJoin(purchases, eq(purchases.id, payables.purchaseId))
      .where(and(eq(payables.tenantId, ctx.tenantId), inArray(payables.status, ["OPEN", "PARTIAL"]))),
    tx.select({
      partyName: suppliers.name,
      source: sql<string>`'Opening balance'`,
      balance: openingBalances.balance,
      dueDate: openingBalances.dueDate,
      basisDate: sql<string>`to_char(${openingBalances.createdAt}, 'YYYY-MM-DD')`,
    })
      .from(openingBalances)
      .innerJoin(suppliers, eq(suppliers.id, openingBalances.supplierId))
      .where(and(eq(openingBalances.tenantId, ctx.tenantId), eq(openingBalances.entryType, "SUPPLIER_PAYABLE"), inArray(openingBalances.status, ["OPEN", "PARTIAL"]))),
  ]));
  return ageRows([
    ...invoices.map((row) => ({ ...row, source: row.source ?? "Purchase", kind: "PURCHASE" as const })),
    ...openings.map((row) => ({ ...row, kind: "OPENING" as const })),
  ], asOfDate);
}
