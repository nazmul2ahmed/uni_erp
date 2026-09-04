import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  items,
  sales,
  saleItems,
  stockBalances,
  tenants,
  warehouses,
  withTenantTransaction,
} from "@erp/db";
import type { TenantContext } from "../guard";
import { getFinanceSummary } from "./finance";

export type ReportDateFilter = { dateFrom?: string; dateTo?: string };

const postedSaleStatuses: Array<"CONFIRMED" | "PARTIALLY_PAID" | "PAID" | "DUE" | "COMPLETED"> = ["CONFIRMED", "PARTIALLY_PAID", "PAID", "DUE", "COMPLETED"];

function dateFilters(filter: ReportDateFilter) {
  return [
    filter.dateFrom ? gte(sales.saleDate, new Date(filter.dateFrom)) : undefined,
    filter.dateTo ? lte(sales.saleDate, new Date(`${filter.dateTo}T23:59:59.999Z`)) : undefined,
  ];
}

export async function getSalesReport(ctx: TenantContext, filter: ReportDateFilter = {}) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const where = and(
      eq(sales.tenantId, ctx.tenantId),
      inArray(sales.status, postedSaleStatuses),
      ...dateFilters(filter),
    );
    const [summary, trend, topItems] = await Promise.all([
      tx
        .select({
          transactionCount: sql<number>`count(*)`,
          grossSales: sql<string>`coalesce(sum(${sales.grandTotal}), 0)`,
          paidSales: sql<string>`coalesce(sum(${sales.paidTotal}), 0)`,
          outstandingSales: sql<string>`coalesce(sum(${sales.dueTotal}), 0)`,
        })
        .from(sales)
        .where(where),
      tx
        .select({
          date: sql<string>`to_char(date_trunc('day', ${sales.saleDate}), 'YYYY-MM-DD')`,
          total: sql<string>`coalesce(sum(${sales.grandTotal}), 0)`,
          transactionCount: sql<number>`count(*)`,
        })
        .from(sales)
        .where(where)
        .groupBy(sql`date_trunc('day', ${sales.saleDate})`)
        .orderBy(asc(sql`date_trunc('day', ${sales.saleDate})`)),
      tx
        .select({
          itemId: items.id,
          itemName: items.name,
          sku: items.sku,
          quantity: sql<string>`coalesce(sum(${saleItems.quantity}), 0)`,
          revenue: sql<string>`coalesce(sum(${saleItems.lineTotal}), 0)`,
        })
        .from(saleItems)
        .innerJoin(sales, eq(sales.id, saleItems.saleId))
        .innerJoin(items, eq(items.id, saleItems.itemId))
        .where(and(eq(saleItems.tenantId, ctx.tenantId), where))
        .groupBy(items.id, items.name, items.sku)
        .orderBy(desc(sql`coalesce(sum(${saleItems.lineTotal}), 0)`))
        .limit(10),
    ]);
    return { summary: summary[0] ?? { transactionCount: 0, grossSales: "0", paidSales: "0", outstandingSales: "0" }, trend, topItems };
  });
}

export async function getStockReport(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({
        itemId: items.id,
        itemName: items.name,
        sku: items.sku,
        threshold: items.lowStockThreshold,
        onHand: sql<string>`coalesce(sum(${stockBalances.quantityOnHand}), 0)`,
        reserved: sql<string>`coalesce(sum(${stockBalances.quantityReserved}), 0)`,
      })
      .from(items)
      .leftJoin(stockBalances, and(eq(stockBalances.itemId, items.id), eq(stockBalances.tenantId, ctx.tenantId)))
      .where(and(eq(items.tenantId, ctx.tenantId), eq(items.isActive, true)))
      .groupBy(items.id, items.name, items.sku, items.lowStockThreshold)
      .orderBy(asc(items.name));

    return rows.map((row) => ({
      ...row,
      available: (Number(row.onHand) - Number(row.reserved)).toString(),
      isLowStock: row.threshold !== null && Number(row.onHand) - Number(row.reserved) <= Number(row.threshold),
    }));
  });
}

export async function getDashboardReport(ctx: TenantContext, filter: ReportDateFilter = {}) {
  const [salesReport, stockReport, finance, tenant] = await Promise.all([
    getSalesReport(ctx, filter),
    getStockReport(ctx),
    getFinanceSummary(ctx),
    withTenantTransaction(ctx.tenantId, async (tx) => tx.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) })),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    currency: tenant?.baseCurrency ?? "BDT",
    sales: salesReport,
    stock: {
      lowStockCount: stockReport.filter((row) => row.isLowStock).length,
      outOfStockCount: stockReport.filter((row) => Number(row.available) <= 0).length,
      items: stockReport,
    },
    finance,
  };
}