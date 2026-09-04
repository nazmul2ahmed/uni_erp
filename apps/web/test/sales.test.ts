import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  completeSale: vi.fn(),
  listSales: vi.fn(),
}));

vi.mock("@/lib/guard", () => ({ requireTenantContext: mocks.requireTenantContext, requirePermission: mocks.requirePermission }));
vi.mock("@/lib/use-cases/sale", () => ({ completeSale: mocks.completeSale, listSales: mocks.listSales }));
vi.mock("@/lib/api-response", () => ({ apiHandler: (fn: () => unknown) => fn }));

import { GET, POST } from "../app/api/sales/route";

const context = { requestId: "request-1", userId: "user-1", tenantId: "tenant-a", membershipId: "membership-1", roleId: "owner-role", storageMode: "SHARED" as const };

function request(url: string, body?: unknown, headers?: Record<string, string>): Request {
  return new Request(url, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireTenantContext.mockResolvedValue(context);
  mocks.requirePermission.mockResolvedValue(undefined);
  mocks.completeSale.mockResolvedValue({ id: "sale-1", invoiceNumber: "INV-1" });
  mocks.listSales.mockResolvedValue([]);
});

describe("sales routes", () => {
  it("requires sales.view for the server-side list", async () => {
    await GET(request("http://localhost/api/sales?q=INV-1") as never);
    expect(mocks.requirePermission).toHaveBeenCalledWith(context, "sales.view");
    expect(mocks.listSales).toHaveBeenCalledWith(context, expect.objectContaining({ q: "INV-1" }));
  });

  it("requires a valid idempotency key for completion", async () => {
    await expect(POST(request("http://localhost/api/sales", { lines: [] }, { "Content-Type": "application/json" }) as never)).rejects.toThrow("Idempotency-Key");
    await POST(request("http://localhost/api/sales", { branchId: "11111111-1111-4111-8111-111111111111", lines: [{ itemId: "11111111-1111-4111-8111-111111111112", quantity: "1", unitPrice: "10", warehouseId: "11111111-1111-4111-8111-111111111113" }] }, { "Content-Type": "application/json", "Idempotency-Key": "11111111-1111-4111-8111-111111111114" }) as never);
    expect(mocks.requirePermission).toHaveBeenCalledWith(context, "sales.create");
    expect(mocks.completeSale).toHaveBeenCalledOnce();
  });
});