import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  listWarehouses: vi.fn(),
  listStockBalances: vi.fn(),
  listStockMovements: vi.fn(),
}));

vi.mock("@/lib/guard", () => ({
  requireTenantContext: mocks.requireTenantContext,
  requirePermission: mocks.requirePermission,
}));

vi.mock("@/lib/use-cases/warehouse", () => ({
  listWarehouses: mocks.listWarehouses,
}));

vi.mock("@/lib/use-cases/inventory", () => ({
  listStockBalances: mocks.listStockBalances,
  listStockMovements: mocks.listStockMovements,
}));

vi.mock("@/lib/api-response", () => ({
  apiHandler: (fn: () => unknown) => fn,
}));

import { GET as getWarehouses } from "../app/api/warehouses/route";
import { GET as getStock } from "../app/api/inventory/stock/route";
import { GET as getMovements } from "../app/api/inventory/movements/route";

const ctx = {
  requestId: "req-1",
  userId: "user-1",
  tenantId: "tenant-a",
  membershipId: "membership-1",
  roleId: "role-1",
  storageMode: "SHARED" as const,
  permissions: [] as string[], // requirePermission is mocked in this suite; content is irrelevant here
};

function request(url: string) {
  return { url } as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireTenantContext.mockResolvedValue(ctx);
  mocks.requirePermission.mockResolvedValue(undefined);
});

describe("inventory routes", () => {
  it("lists warehouses for the active tenant", async () => {
    mocks.listWarehouses.mockResolvedValue([{ id: "w-1", name: "Main Warehouse", code: "WH-01", isActive: true }]);

    const result = await getWarehouses();

    // FIX (Phase 2 code-verification pass — confirmed permission-mapping
    // bug, per Decision DB-012 / 11 §15): this assertion previously
    // pinned the BUGGY permission ("catalog.manage") as expected
    // behavior — corrected to the documented "settings.view".
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "settings.view");
    expect(result).toEqual([{ id: "w-1", name: "Main Warehouse", code: "WH-01", isActive: true }]);
  });

  it("lists stock balances and movement history with tenant guard enforcement", async () => {
    mocks.listStockBalances.mockResolvedValue([{ itemId: "i-1", warehouseId: "w-1", quantityOnHand: "12" }]);
    mocks.listStockMovements.mockResolvedValue([{ id: "m-1", movementType: "ADJUSTMENT_IN", quantity: "5" }]);

    const balances = await getStock(request("http://localhost/api/inventory/stock"));
    const movements = await getMovements(request("http://localhost/api/inventory/movements"));

    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "inventory.view");
    expect(balances).toEqual([{ itemId: "i-1", warehouseId: "w-1", quantityOnHand: "12" }]);
    expect(movements).toEqual([{ id: "m-1", movementType: "ADJUSTMENT_IN", quantity: "5" }]);
  });
});
