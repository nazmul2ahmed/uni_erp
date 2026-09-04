import { and, eq, desc } from "drizzle-orm";
import { stockBalances, stockMovements, warehouses, items, withTenantTransaction } from "@erp/db";
import { AppError } from "@erp/shared";
import type { TenantContext } from "../guard";

export async function listStockBalances(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    return tx.query.stockBalances.findMany({
      where: eq(stockBalances.tenantId, ctx.tenantId),
      orderBy: (row, { asc }) => [asc(row.itemId), asc(row.warehouseId)],
    });
  });
}

export async function listStockMovements(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    return tx.query.stockMovements.findMany({
      where: eq(stockMovements.tenantId, ctx.tenantId),
      orderBy: (row, { desc }) => [desc(row.occurredAt)],
      limit: 200,
    });
  });
}

export async function getInventorySummary(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const [itemCount, warehouseCount, balanceRows, movementRows] = await Promise.all([
      tx.query.items.findMany({ where: and(eq(items.tenantId, ctx.tenantId)) }),
      tx.query.warehouses.findMany({ where: eq(warehouses.tenantId, ctx.tenantId) }),
      tx.query.stockBalances.findMany({ where: eq(stockBalances.tenantId, ctx.tenantId) }),
      tx.query.stockMovements.findMany({ where: eq(stockMovements.tenantId, ctx.tenantId), limit: 10 }),
    ]);

    const totalUnits = balanceRows.reduce((sum, row) => sum + Number(row.quantityOnHand ?? 0), 0);
    return {
      itemCount: itemCount.length,
      warehouseCount: warehouseCount.length,
      totalUnits,
      movementCount: movementRows.length,
    };
  });
}

export async function getStockBalanceByItem(ctx: TenantContext, itemId: string, warehouseId?: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const where = warehouseId
      ? and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, itemId), eq(stockBalances.warehouseId, warehouseId))
      : and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, itemId));

    const row = await tx.query.stockBalances.findFirst({ where });
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "No stock balance found");
    return row;
  });
}
