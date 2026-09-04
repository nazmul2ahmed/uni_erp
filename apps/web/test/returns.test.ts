import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  adjustStock: vi.fn(),
  listStockAdjustments: vi.fn(),
}));

vi.mock("@/lib/guard", () => ({ requireTenantContext: mocks.requireTenantContext, requirePermission: mocks.requirePermission }));
vi.mock("@/lib/use-cases/returns", () => ({ adjustStock: mocks.adjustStock, listStockAdjustments: mocks.listStockAdjustments }));
vi.mock("@/lib/api-response", () => ({ apiHandler: (fn: () => unknown) => fn }));

import { GET, POST } from "../app/api/inventory/adjustments/route";

const ctx = { requestId: "req-1", userId: "user-1", tenantId: "tenant-a", membershipId: "member-1", roleId: "role-1", storageMode: "SHARED" as const };

describe("inventory adjustment route", () => {
  it("requires an idempotency key for mutations", async () => {
    mocks.requireTenantContext.mockResolvedValue(ctx);
    mocks.requirePermission.mockResolvedValue(undefined);
    await expect(POST(new Request("http://localhost/api/inventory/adjustments", { method: "POST", body: JSON.stringify({}) }) as never)).rejects.toThrow("Idempotency-Key");
    expect(mocks.adjustStock).not.toHaveBeenCalled();
  });

  it("uses the tenant guard and inventory capability for history", async () => {
    mocks.requireTenantContext.mockResolvedValue(ctx);
    mocks.requirePermission.mockResolvedValue(undefined);
    mocks.listStockAdjustments.mockResolvedValue([{ id: "adjustment-1", tenantId: "tenant-a" }]);
    const response = await GET();
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "inventory.adjust");
    expect(response).toEqual([{ id: "adjustment-1", tenantId: "tenant-a" }]);
  });
});