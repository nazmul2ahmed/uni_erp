import { and, asc, eq, isNull } from "drizzle-orm";
import {
  items,
  payables,
  purchases,
  purchaseItems,
  receivables,
  returnLines,
  returns,
  saleItems,
  sales,
  stockAdjustments,
  stockBalances,
  stockBatches,
  stockMovements,
  warehouses,
  withTenantTransaction,
} from "@erp/db";
import { AppError } from "@erp/shared";
import type { Database } from "@erp/db";
import type { CustomerReturnInput, StockAdjustmentInput, SupplierReturnInput } from "@erp/validation";
import type { TenantContext } from "../guard";

const scale = 10000n;

function units(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const sign = whole?.startsWith("-") ? -1n : 1n;
  const normalizedWhole = (whole ?? "0").replace("-", "");
  return sign * (BigInt(normalizedWhole) * scale + BigInt(fraction.padEnd(4, "0").slice(0, 4)));
}

function decimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % scale).toString().padStart(4, "0").replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${absolute / scale}${fraction ? `.${fraction}` : ""}`;
}

function sumQuantities(rows: Array<{ quantity: string }>): bigint {
  return rows.reduce((total, row) => total + units(row.quantity), 0n);
}

async function updateBalance(tx: Database, ctx: TenantContext, itemId: string, warehouseId: string, batchId: string | null, delta: bigint, allowNegative: boolean) {
  const batchCondition = batchId ? eq(stockBalances.batchId, batchId) : isNull(stockBalances.batchId);
  const row = await tx.select().from(stockBalances).where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, itemId), eq(stockBalances.warehouseId, warehouseId), batchCondition)).for("update");
  const previous = units(row[0]?.quantityOnHand ?? "0");
  const resulting = previous + delta;
  if (!allowNegative && resulting < 0n) throw new AppError("INSUFFICIENT_STOCK", "Insufficient stock for return or adjustment", { available: decimal(previous), requested: decimal(-delta) });
  if (row[0]) await tx.update(stockBalances).set({ quantityOnHand: decimal(resulting), updatedAt: new Date() }).where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, itemId), eq(stockBalances.warehouseId, warehouseId), batchCondition));
  else await tx.insert(stockBalances).values({ tenantId: ctx.tenantId, itemId, warehouseId, batchId, quantityOnHand: decimal(resulting), weightedAvgCost: null });
  return { previous, resulting };
}

async function assertWarehouse(tx: Database, ctx: TenantContext, warehouseId: string) {
  const warehouse = await tx.query.warehouses.findFirst({ where: and(eq(warehouses.id, warehouseId), eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.isActive, true)) });
  if (!warehouse) throw new AppError("RESOURCE_NOT_FOUND", "Warehouse not found or inactive");
}

export async function completeCustomerReturn(ctx: TenantContext, input: CustomerReturnInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const replay = await tx.query.returns.findFirst({ where: and(eq(returns.tenantId, ctx.tenantId), eq(returns.operationId, operationId)) });
    if (replay) return replay;
    await assertWarehouse(tx, ctx, input.warehouseId);
    const sale = await tx.query.sales.findFirst({ where: and(eq(sales.id, input.saleId), eq(sales.tenantId, ctx.tenantId)) });
    if (!sale || !sale.customerId) throw new AppError("RESOURCE_NOT_FOUND", "Sale not found or has no customer");
    const sourceLines = await tx.query.saleItems.findMany({ where: and(eq(saleItems.saleId, sale.id), eq(saleItems.tenantId, ctx.tenantId)) });
    const selected = [] as Array<{ source: typeof sourceLines[number] & { batchId: string | null }; quantity: bigint; total: bigint }>;
    for (const requested of input.lines) {
      const source = sourceLines.find((line) => line.id === requested.sourceLineId);
      if (!source || source.warehouseId !== input.warehouseId) throw new AppError("RESOURCE_NOT_FOUND", "Sale line not found in the selected warehouse");
      const prior = await tx.query.returnLines.findMany({ where: and(eq(returnLines.tenantId, ctx.tenantId), eq(returnLines.saleItemId, source.id)) });
      const remaining = units(source.quantity) - sumQuantities(prior);
      const quantity = units(requested.quantity);
      if (quantity > remaining) throw new AppError("RETURN_QTY_EXCEEDED", "Return quantity exceeds the remaining sale quantity", { requested: requested.quantity, remaining: decimal(remaining) });
      selected.push({ source, quantity, total: quantity * units(source.unitPrice) / scale });
    }
    const total = selected.reduce((sum, line) => sum + line.total, 0n);
    const [record] = await tx.insert(returns).values({ tenantId: ctx.tenantId, type: "CUSTOMER_RETURN", saleId: sale.id, partyId: sale.customerId, warehouseId: input.warehouseId, subtotal: decimal(total), grandTotal: decimal(total), operationId, notes: input.notes, createdBy: ctx.userId }).returning();
    if (!record) throw new AppError("INTERNAL_ERROR", "Unable to create customer return");
    for (const line of selected) {
      await tx.insert(returnLines).values({ tenantId: ctx.tenantId, returnId: record.id, saleItemId: line.source.id, itemId: line.source.itemId, warehouseId: line.source.warehouseId, batchId: line.source.batchId, quantity: decimal(line.quantity), unitPrice: line.source.unitPrice, lineTotal: decimal(line.total) });
      const item = await tx.query.items.findFirst({ where: and(eq(items.id, line.source.itemId), eq(items.tenantId, ctx.tenantId)) });
      if (!item) throw new AppError("RESOURCE_NOT_FOUND", "Item not found");
      await updateBalance(tx, ctx, line.source.itemId, line.source.warehouseId, line.source.batchId, line.quantity, item.allowNegativeStock);
      await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: line.source.itemId, warehouseId: line.source.warehouseId, batchId: line.source.batchId, serialId: line.source.serialId, movementType: "CUSTOMER_RETURN", quantity: decimal(line.quantity), referenceType: "RETURN", referenceId: record.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });
    }
    const receivable = await tx.query.receivables.findFirst({ where: and(eq(receivables.tenantId, ctx.tenantId), eq(receivables.saleId, sale.id)) });
    if (receivable) {
      const nextAmount = units(receivable.amount) - total;
      const nextBalance = units(receivable.balance) - total;
      await tx.update(receivables).set({ amount: decimal(nextAmount > 0n ? nextAmount : 0n), balance: decimal(nextBalance > 0n ? nextBalance : 0n), status: nextBalance <= 0n ? "SETTLED" : receivable.status, updatedAt: new Date() }).where(eq(receivables.id, receivable.id));
    }
    return record;
  });
}

export async function completeSupplierReturn(ctx: TenantContext, input: SupplierReturnInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const replay = await tx.query.returns.findFirst({ where: and(eq(returns.tenantId, ctx.tenantId), eq(returns.operationId, operationId)) });
    if (replay) return replay;
    await assertWarehouse(tx, ctx, input.warehouseId);
    const purchase = await tx.query.purchases.findFirst({ where: and(eq(purchases.id, input.purchaseId), eq(purchases.tenantId, ctx.tenantId)) });
    if (!purchase) throw new AppError("RESOURCE_NOT_FOUND", "Purchase not found");
    const sourceLines = await tx.query.purchaseItems.findMany({ where: and(eq(purchaseItems.purchaseId, purchase.id), eq(purchaseItems.tenantId, ctx.tenantId)) });
    const selected = [] as Array<{ source: typeof sourceLines[number] & { batchId: string | null }; quantity: bigint; total: bigint }>;
    for (const requested of input.lines) {
      const source = sourceLines.find((line) => line.id === requested.sourceLineId);
      if (!source || source.warehouseId !== input.warehouseId) throw new AppError("RESOURCE_NOT_FOUND", "Purchase line not found in the selected warehouse");
      const prior = await tx.query.returnLines.findMany({ where: and(eq(returnLines.tenantId, ctx.tenantId), eq(returnLines.purchaseItemId, source.id)) });
      const remaining = units(source.quantity) - sumQuantities(prior);
      const quantity = units(requested.quantity);
      if (quantity > remaining) throw new AppError("RETURN_QTY_EXCEEDED", "Return quantity exceeds the remaining purchase quantity", { requested: requested.quantity, remaining: decimal(remaining) });
      const batch = source.batchNumber ? await tx.query.stockBatches.findFirst({ where: and(eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, source.itemId), eq(stockBatches.batchNumber, source.batchNumber)) }) : null;
      selected.push({ source: { ...source, batchId: batch?.id ?? null }, quantity, total: quantity * units(source.costPrice) / scale });
    }
    const total = selected.reduce((sum, line) => sum + line.total, 0n);
    const [record] = await tx.insert(returns).values({ tenantId: ctx.tenantId, type: "SUPPLIER_RETURN", purchaseId: purchase.id, partyId: purchase.supplierId, warehouseId: input.warehouseId, subtotal: decimal(total), grandTotal: decimal(total), operationId, notes: input.notes, createdBy: ctx.userId }).returning();
    if (!record) throw new AppError("INTERNAL_ERROR", "Unable to create supplier return");
    for (const line of selected) {
      await tx.insert(returnLines).values({ tenantId: ctx.tenantId, returnId: record.id, purchaseItemId: line.source.id, itemId: line.source.itemId, warehouseId: line.source.warehouseId, batchId: line.source.batchId, quantity: decimal(line.quantity), unitPrice: line.source.costPrice, lineTotal: decimal(line.total) });
      const item = await tx.query.items.findFirst({ where: and(eq(items.id, line.source.itemId), eq(items.tenantId, ctx.tenantId)) });
      if (!item) throw new AppError("RESOURCE_NOT_FOUND", "Item not found");
      await updateBalance(tx, ctx, line.source.itemId, line.source.warehouseId, line.source.batchId, -line.quantity, item.allowNegativeStock);
      await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: line.source.itemId, warehouseId: line.source.warehouseId, batchId: line.source.batchId, movementType: "SUPPLIER_RETURN", quantity: decimal(-line.quantity), referenceType: "RETURN", referenceId: record.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });
    }
    const payable = await tx.query.payables.findFirst({ where: and(eq(payables.tenantId, ctx.tenantId), eq(payables.purchaseId, purchase.id)) });
    if (payable) {
      const nextAmount = units(payable.amount) - total;
      const nextBalance = units(payable.balance) - total;
      await tx.update(payables).set({ amount: decimal(nextAmount > 0n ? nextAmount : 0n), balance: decimal(nextBalance > 0n ? nextBalance : 0n), status: nextBalance <= 0n ? "SETTLED" : payable.status, updatedAt: new Date() }).where(eq(payables.id, payable.id));
    }
    return record;
  });
}

export async function adjustStock(ctx: TenantContext, input: StockAdjustmentInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const replay = await tx.query.stockAdjustments.findFirst({ where: and(eq(stockAdjustments.tenantId, ctx.tenantId), eq(stockAdjustments.operationId, operationId)) });
    if (replay) return replay;
    await assertWarehouse(tx, ctx, input.warehouseId);
    const item = await tx.query.items.findFirst({ where: and(eq(items.id, input.itemId), eq(items.tenantId, ctx.tenantId), eq(items.isActive, true)) });
    if (!item) throw new AppError("RESOURCE_NOT_FOUND", "Item not found or inactive");
    if ((item.batchTracked || item.expiryTracked) && !input.batchId) throw new AppError("VALIDATION_FAILED", "A batch is required for this item");
    if (!item.batchTracked && input.batchId) throw new AppError("VALIDATION_FAILED", "This item does not accept a batch");
    if (input.batchId) {
      const batch = await tx.query.stockBatches.findFirst({ where: and(eq(stockBatches.id, input.batchId), eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, item.id)) });
      if (!batch) throw new AppError("RESOURCE_NOT_FOUND", "Batch not found for item");
    }
    const delta = units(input.quantityDelta);
    const balance = await updateBalance(tx, ctx, item.id, input.warehouseId, input.batchId ?? null, delta, item.allowNegativeStock);
    const [record] = await tx.insert(stockAdjustments).values({ tenantId: ctx.tenantId, itemId: item.id, warehouseId: input.warehouseId, batchId: input.batchId ?? null, quantityDelta: decimal(delta), previousQuantity: decimal(balance.previous), resultingQuantity: decimal(balance.resulting), reason: input.reason, reference: input.reference, operationId, createdBy: ctx.userId }).returning();
    if (!record) throw new AppError("INTERNAL_ERROR", "Unable to create stock adjustment");
    await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: item.id, warehouseId: input.warehouseId, batchId: input.batchId ?? null, movementType: delta > 0n ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT", quantity: decimal(delta), referenceType: "ADJUSTMENT", referenceId: record.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });
    return record;
  });
}

export async function listReturns(ctx: TenantContext, filters: { type?: "CUSTOMER_RETURN" | "SUPPLIER_RETURN"; saleId?: string; purchaseId?: string }) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.returns.findMany({ where: and(eq(returns.tenantId, ctx.tenantId), filters.type ? eq(returns.type, filters.type) : undefined, filters.saleId ? eq(returns.saleId, filters.saleId) : undefined, filters.purchaseId ? eq(returns.purchaseId, filters.purchaseId) : undefined), orderBy: [asc(returns.returnDate)] }));
}

export async function getReturn(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const record = await tx.query.returns.findFirst({ where: and(eq(returns.id, id), eq(returns.tenantId, ctx.tenantId)) });
    if (!record) throw new AppError("RESOURCE_NOT_FOUND", "Return not found");
    const lines = await tx.query.returnLines.findMany({ where: and(eq(returnLines.returnId, id), eq(returnLines.tenantId, ctx.tenantId)) });
    return { return: record, lines };
  });
}

export async function listStockAdjustments(ctx: TenantContext) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.stockAdjustments.findMany({
    where: eq(stockAdjustments.tenantId, ctx.tenantId),
    orderBy: [asc(stockAdjustments.createdAt)],
    limit: 200,
  }));
}