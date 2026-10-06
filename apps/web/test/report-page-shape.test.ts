import { describe, expect, it } from "vitest";
import { normalizeReportData } from "../lib/report-normalizer";

describe("normalizeReportData", () => {
  it("maps the widget dashboard payload to the legacy report shape", () => {
    const input = {
      generatedAt: "2026-10-06T00:00:00.000Z",
      currency: "BDT",
      widgets: [
        {
          key: "sales-summary",
          data: {
            summary: {
              transactionCount: 2,
              grossSales: "1500",
              paidSales: "1200",
              outstandingSales: "300",
            },
            trend: [
              { date: "2026-10-01", total: "500", transactionCount: 1 },
              { date: "2026-10-02", total: "1000", transactionCount: 1 },
            ],
            topItems: [
              { itemId: "item-1", itemName: "Aspirin", sku: "ASP-1", quantity: "5", revenue: "250" },
            ],
          },
        },
        {
          key: "low-stock",
          data: {
            lowStockCount: 3,
            outOfStockCount: 1,
            items: [
              {
                itemId: "item-2",
                itemName: "Bandage",
                sku: "BND-2",
                threshold: "10",
                onHand: "8",
                reserved: "2",
                available: "6",
                isLowStock: true,
              },
            ],
          },
        },
      ],
    };

    const salesWidget = input.widgets?.[0]?.data as { summary: { transactionCount: number; grossSales: string; paidSales: string; outstandingSales: string }; trend: Array<{ date: string; total: string; transactionCount: number }>; topItems: Array<{ itemId: string; itemName: string; sku: string | null; quantity: string; revenue: string }> };

    expect(normalizeReportData(input)).toEqual({
      generatedAt: input.generatedAt,
      currency: input.currency,
      sales: {
        summary: salesWidget.summary,
        trend: salesWidget.trend,
        topItems: salesWidget.topItems,
      },
      stock: {
        lowStockCount: 3,
        outOfStockCount: 1,
        items: [
          {
            itemId: "item-2",
            itemName: "Bandage",
            sku: "BND-2",
            threshold: "10",
            onHand: "8",
            reserved: "2",
            available: "6",
            isLowStock: true,
          },
        ],
      },
      finance: {
        receivables: "0",
        payables: "0",
        cash: "0",
        bank: "0",
      },
    });
  });
});
