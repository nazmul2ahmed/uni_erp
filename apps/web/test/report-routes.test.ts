import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  getDashboardReport: vi.fn(),
  getSalesReport: vi.fn(),
  getStockReport: vi.fn(),
}));

vi.mock("@/lib/guard", () => ({ requireTenantContext: mocks.requireTenantContext, requirePermission: mocks.requirePermission }));
vi.mock("@/lib/use-cases/reports", () => ({ getDashboardReport: mocks.getDashboardReport, getSalesReport: mocks.getSalesReport, getStockReport: mocks.getStockReport }));
vi.mock("@/lib/api-response", () => ({ apiHandler: (fn: () => unknown) => fn }));

import { GET as dashboard } from "../app/api/reports/dashboard/route";
import { GET as sales } from "../app/api/reports/sales/route";
import { GET as stock } from "../app/api/reports/stock/route";

const context = { requestId: "request-1", userId: "user-1", tenantId: "tenant-a", membershipId: "membership-1", roleId: "role-1", storageMode: "SHARED" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireTenantContext.mockResolvedValue(context);
  mocks.requirePermission.mockResolvedValue(undefined);
  mocks.getDashboardReport.mockResolvedValue({});
  mocks.getSalesReport.mockResolvedValue({});
  mocks.getStockReport.mockResolvedValue([]);
});

describe("report routes", () => {
  it("requires the existing accounting report permission and forwards date filters", async () => {
    await dashboard(new Request("http://localhost/api/reports/dashboard?dateFrom=2026-01-01&dateTo=2026-01-31") as never);

    expect(mocks.requirePermission).toHaveBeenCalledWith(context, "accounting.view");
    expect(mocks.getDashboardReport).toHaveBeenCalledWith(context, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  });

  it("rejects an inverted date range before querying the report", async () => {
    await expect(sales(new Request("http://localhost/api/reports/sales?dateFrom=2026-02-01&dateTo=2026-01-01") as never)).rejects.toThrow("Invalid report date range");
    expect(mocks.getSalesReport).not.toHaveBeenCalled();
  });

  it("protects stock status with the same tenant and permission guards", async () => {
    await stock();

    expect(mocks.requireTenantContext).toHaveBeenCalledOnce();
    expect(mocks.requirePermission).toHaveBeenCalledWith(context, "accounting.view");
    expect(mocks.getStockReport).toHaveBeenCalledWith(context);
  });
});
