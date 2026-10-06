export type ReportSalesSummary = { transactionCount: number; grossSales: string; paidSales: string; outstandingSales: string };
export type ReportSalesTrend = { date: string; total: string; transactionCount: number };
export type ReportTopItem = { itemId: string; itemName: string; sku: string | null; quantity: string; revenue: string };
export type ReportStockItem = { itemId: string; itemName: string; sku: string | null; threshold: string | null; onHand: string; reserved: string; available: string; isLowStock: boolean };
export type ReportData = { generatedAt: string; currency: string; sales: { summary: ReportSalesSummary; trend: ReportSalesTrend[]; topItems: ReportTopItem[] }; stock: { lowStockCount: number; outOfStockCount: number; items: ReportStockItem[] }; finance: { receivables: string; payables: string; cash: string; bank: string } };
export type DashboardWidgetPayload = { generatedAt: string; currency: string; widgets?: Array<{ key: string; data?: unknown }> };

const defaultSummary: ReportSalesSummary = { transactionCount: 0, grossSales: "0", paidSales: "0", outstandingSales: "0" };
const defaultFinance = { receivables: "0", payables: "0", cash: "0", bank: "0" };

function widgetData<T>(payload: DashboardWidgetPayload | ReportData, key: string): T | null {
  if ("widgets" in payload) {
    const widget = payload.widgets?.find((candidate) => candidate.key === key);
    return widget && widget.data ? (widget.data as T) : null;
  }
  return null;
}

export function normalizeReportData(payload: DashboardWidgetPayload | ReportData | null | undefined): ReportData {
  const base: ReportData = {
    generatedAt: payload?.generatedAt ?? new Date().toISOString(),
    currency: payload?.currency ?? "BDT",
    sales: {
      summary: defaultSummary,
      trend: [],
      topItems: [],
    },
    stock: {
      lowStockCount: 0,
      outOfStockCount: 0,
      items: [],
    },
    finance: { ...defaultFinance },
  };

  if (!payload) return base;

  if ("sales" in payload && "stock" in payload) {
    return {
      ...base,
      generatedAt: payload.generatedAt,
      currency: payload.currency,
      sales: {
        summary: payload.sales?.summary ?? defaultSummary,
        trend: payload.sales?.trend ?? [],
        topItems: payload.sales?.topItems ?? [],
      },
      stock: {
        lowStockCount: payload.stock?.lowStockCount ?? 0,
        outOfStockCount: payload.stock?.outOfStockCount ?? 0,
        items: payload.stock?.items ?? [],
      },
      finance: {
        receivables: payload.finance?.receivables ?? "0",
        payables: payload.finance?.payables ?? "0",
        cash: payload.finance?.cash ?? "0",
        bank: payload.finance?.bank ?? "0",
      },
    };
  }

  const sales = widgetData<{ summary?: ReportSalesSummary; trend?: ReportSalesTrend[]; topItems?: ReportTopItem[] }>(payload, "sales-summary");
  const stock = widgetData<{ lowStockCount?: number; outOfStockCount?: number; items?: ReportStockItem[] }>(payload, "low-stock");

  return {
    ...base,
    generatedAt: payload.generatedAt,
    currency: payload.currency,
    sales: {
      summary: sales?.summary ?? defaultSummary,
      trend: sales?.trend ?? [],
      topItems: sales?.topItems ?? [],
    },
    stock: {
      lowStockCount: stock?.lowStockCount ?? 0,
      outOfStockCount: stock?.outOfStockCount ?? 0,
      items: stock?.items ?? [],
    },
    finance: { ...defaultFinance },
  };
}
