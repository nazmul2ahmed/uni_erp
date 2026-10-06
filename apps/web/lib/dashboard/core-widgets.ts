/**
 * Core dashboard widgets -- 12_UX_SPECIFICATION.md s8, Decision RPT-002.
 *
 * Permission model:
 *   - Sales Summary / Low Stock        -> reports.view   (11 s19)
 *   - Cash / Receivables / Payables    -> accounting.view (the same gate as
 *     the underlying /api/finance, /api/receivables, /api/payables routes --
 *     a reports.view-only role must NOT see ledger balances)
 * The dashboard ROUTE additionally requires reports.view; a widget's own
 * permissions are enforced by the registry on top of that.
 *
 * Profit Snapshot (12 s8) needs BOTH reports.view and accounting.view -- it
 * discloses revenue, cost and expense totals derived from the ledger, so it
 * sits behind the ledger permission too. It calls the shared P&L use case
 * (08 s6.2, Decision ACC-006); the dashboard has no profit rule of its own.
 */
import { getFinanceSummary } from "../use-cases/finance";
import { getProfitAndLoss } from "../use-cases/profit-loss";
import { getSalesReport, getStockReport } from "../use-cases/reports";
import type { DashboardWidget } from "./registry";

export const coreWidgets: DashboardWidget[] = [
  {
    key: "sales-summary",
    title: "Sales Summary",
    requiredPermissions: ["reports.view"],
    load: ({ ctx, filter, once }) => once("sales", () => getSalesReport(ctx, filter)),
  },
  {
    key: "low-stock",
    title: "Low Stock / Out of Stock",
    requiredPermissions: ["reports.view"],
    load: async ({ ctx, once }) => {
      const rows = await once("stock", () => getStockReport(ctx));
      return {
        lowStockCount: rows.filter((row) => row.isLowStock).length,
        outOfStockCount: rows.filter((row) => Number(row.available) <= 0).length,
        items: rows,
      };
    },
  },
  {
    key: "cash-position",
    title: "Cash Position",
    requiredPermissions: ["accounting.view"],
    load: async ({ ctx, once }) => {
      const finance = await once("finance", () => getFinanceSummary(ctx));
      return { cash: finance.cash, bank: finance.bank };
    },
  },
  {
    key: "receivables-due",
    title: "Receivables Due",
    requiredPermissions: ["accounting.view"],
    load: async ({ ctx, once }) => {
      const finance = await once("finance", () => getFinanceSummary(ctx));
      return { receivables: finance.receivables };
    },
  },
  {
    key: "payables-due",
    title: "Payables Due",
    requiredPermissions: ["accounting.view"],
    load: async ({ ctx, once }) => {
      const finance = await once("finance", () => getFinanceSummary(ctx));
      return { payables: finance.payables };
    },
  },
  {
    key: "profit-snapshot",
    title: "Profit Snapshot",
    requiredPermissions: ["reports.view", "accounting.view"],
    load: ({ ctx, filter }) => getProfitAndLoss(ctx, filter),
  },
];
