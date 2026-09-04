import { and, eq, desc } from "drizzle-orm";
import { stockBalances, stockMovements, stockBatches, warehouses, items, withTenantTransaction } from "@erp/db";
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

export async function getStockSummary(ctx: TenantContext, itemId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const item = await tx.query.items.findFirst({ where: and(eq(items.id, itemId), eq(items.tenantId, ctx.tenantId), eq(items.isActive, true)) });
    if (!item) throw new AppError("RESOURCE_NOT_FOUND", "Item not found");
    const [balances, batches] = await Promise.all([
      tx.query.stockBalances.findMany({ where: and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, itemId)) }),
      tx.query.stockBatches.findMany({ where: and(eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, itemId)) }),
    ]);
    return {
      onHand: balances.reduce((sum, row) => sum + Number(row.quantityOnHand), 0),
      reserved: balances.reduce((sum, row) => sum + Number(row.quantityReserved), 0),
      byWarehouse: balances.map((row) => ({ warehouseId: row.warehouseId, batchId: row.batchId, onHand: row.quantityOnHand, reserved: row.quantityReserved })),
      byBatch: batches.map((batch) => ({ id: batch.id, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, balances: balances.filter((row) => row.batchId === batch.id).map((row) => ({ warehouseId: row.warehouseId, onHand: row.quantityOnHand, reserved: row.quantityReserved })) })),
    };
  });
}
