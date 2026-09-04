import { and, asc, desc, eq, gte, ilike, isNull, lte } from "drizzle-orm";
import {
  payments,
  paymentAllocations,
  payables,
  purchaseItems,
  purchases,
  stockBatches,
  stockBalances,
  stockMovements,
  suppliers,
  items,
  warehouses,
  branches,
  withTenantTransaction,
} from "@erp/db";
import { AppError } from "@erp/shared";
import type { CreatePurchaseInput, SearchPurchasesQuery } from "@erp/validation";
import type { TenantContext } from "../guard";

const moneyScale = 10000n;

function decimalToUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole ?? "0") * moneyScale + BigInt(fraction.padEnd(4, "0").slice(0, 4));
}

function unitsToDecimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const whole = absolute / moneyScale;
  const fraction = (absolute % moneyScale).toString().padStart(4, "0").replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function lineTotal(quantity: string, costPrice: string, discount: string): string {
  const quantityUnits = decimalToUnits(quantity);
  const costUnits = decimalToUnits(costPrice);
  const discountUnits = decimalToUnits(discount);
  return unitsToDecimal((quantityUnits * costUnits) / moneyScale - discountUnits);
}

function purchaseNumber(): string {
  return `PUR-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

async function getOwnedReferences(tx: Parameters<typeof withTenantTransaction>[1] extends (tx: infer T) => Promise<unknown> ? T : never, ctx: TenantContext, input: CreatePurchaseInput) {
  const supplier = await tx.query.suppliers.findFirst({ where: and(eq(suppliers.id, input.supplierId), eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.isActive, true)) });
  if (!supplier) throw new AppError("RESOURCE_NOT_FOUND", "Supplier not found or inactive");
  const branch = await tx.query.branches.findFirst({ where: and(eq(branches.id, input.branchId), eq(branches.tenantId, ctx.tenantId), eq(branches.isActive, true)) });
  if (!branch) throw new AppError("RESOURCE_NOT_FOUND", "Branch not found or inactive");

  const warehouseIds = [...new Set(input.lines.map((line) => line.warehouseId))];
  const warehouseRows = await tx.query.warehouses.findMany({ where: and(eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.isActive, true)) });
  const warehouseMap = new Map(warehouseRows.map((row) => [row.id, row]));
  if (warehouseIds.some((id) => !warehouseMap.has(id) || warehouseMap.get(id)!.branchId !== branch.id)) throw new AppError("VALIDATION_FAILED", "Every warehouse must belong to the selected branch");

  const itemIds = [...new Set(input.lines.map((line) => line.itemId))];
  const itemRows = await tx.query.items.findMany({ where: and(eq(items.tenantId, ctx.tenantId), eq(items.isActive, true)) });
  const itemMap = new Map(itemRows.filter((row) => itemIds.includes(row.id)).map((row) => [row.id, row]));
  if (itemMap.size !== itemIds.length) throw new AppError("RESOURCE_NOT_FOUND", "One or more items are unavailable");
  return { warehouseMap, itemMap };
}

export async function receivePurchase(ctx: TenantContext, input: CreatePurchaseInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const existing = await tx.query.purchases.findFirst({ where: and(eq(purchases.tenantId, ctx.tenantId), eq(purchases.operationId, operationId)) });
    if (existing) return existing;

    const { warehouseMap, itemMap } = await getOwnedReferences(tx, ctx, input);
    const computedLines = input.lines.map((line) => {
      const item = itemMap.get(line.itemId)!;
      if ((item.batchTracked || item.expiryTracked) && !line.batchNumber) throw new AppError("VALIDATION_FAILED", `${item.name} requires a batch number`);
      if (item.expiryTracked && !line.expiryDate) throw new AppError("VALIDATION_FAILED", `${item.name} requires an expiry date`);
      if (line.expiryDate && input.purchaseDate && line.expiryDate < input.purchaseDate.slice(0, 10)) throw new AppError("VALIDATION_FAILED", `${item.name} expiry cannot be before the purchase date`);
      const total = lineTotal(line.quantity, line.costPrice, line.lineDiscount);
      if (decimalToUnits(total) < 0n) throw new AppError("VALIDATION_FAILED", "Line discount cannot exceed line value");
      return { line, item, warehouse: warehouseMap.get(line.warehouseId)!, total };
    });
    const subtotalUnits = computedLines.reduce((sum, entry) => sum + decimalToUnits(entry.line.quantity) * decimalToUnits(entry.line.costPrice) / moneyScale, 0n);
    const lineDiscountUnits = computedLines.reduce((sum, entry) => sum + decimalToUnits(entry.line.lineDiscount), 0n);
    const grandTotalUnits = subtotalUnits - lineDiscountUnits - decimalToUnits(input.orderDiscount);
    if (grandTotalUnits < 0n) throw new AppError("VALIDATION_FAILED", "Discounts cannot exceed the purchase subtotal");
    const paidUnits = decimalToUnits(input.cashPaid);
    if (paidUnits > grandTotalUnits) throw new AppError("VALIDATION_FAILED", "Payment cannot exceed the purchase total");
    const grandTotal = unitsToDecimal(grandTotalUnits);
    const paidTotal = unitsToDecimal(paidUnits);
    const dueTotal = unitsToDecimal(grandTotalUnits - paidUnits);
    const status = paidUnits === grandTotalUnits ? "PAID" : paidUnits > 0n ? "PARTIALLY_PAID" : "RECEIVED";
    const [purchase] = await tx.insert(purchases).values({
      tenantId: ctx.tenantId, branchId: input.branchId, purchaseNumber: purchaseNumber(), supplierId: input.supplierId,
      status, subtotal: unitsToDecimal(subtotalUnits), discountTotal: unitsToDecimal(lineDiscountUnits + decimalToUnits(input.orderDiscount)),
      taxTotal: "0", grandTotal, paidTotal, dueTotal, purchaseDate: input.purchaseDate ? new Date(input.purchaseDate) : new Date(), operationId, createdBy: ctx.userId,
    }).returning();
    if (!purchase) throw new AppError("INTERNAL_ERROR", "Unable to create purchase");

    for (const entry of computedLines) {
      const { line, item, warehouse, total } = entry;
      let batchId: string | null = null;
      if (line.batchNumber) {
        const existingBatch = await tx.query.stockBatches.findFirst({ where: and(eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, item.id), eq(stockBatches.batchNumber, line.batchNumber)) });
        if (existingBatch) batchId = existingBatch.id;
        else {
          const [batch] = await tx.insert(stockBatches).values({ tenantId: ctx.tenantId, itemId: item.id, batchNumber: line.batchNumber, expiryDate: line.expiryDate, supplierId: input.supplierId, costPrice: line.costPrice }).returning({ id: stockBatches.id });
          batchId = batch!.id;
        }
      }
      await tx.insert(purchaseItems).values({ tenantId: ctx.tenantId, purchaseId: purchase.id, itemId: item.id, description: line.description, quantity: line.quantity, costPrice: line.costPrice, sellingPrice: line.sellingPrice, lineDiscount: line.lineDiscount, taxAmount: "0", lineTotal: total, batchNumber: line.batchNumber, expiryDate: line.expiryDate, warehouseId: warehouse.id });
      await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: item.id, warehouseId: warehouse.id, batchId, movementType: "PURCHASE", quantity: line.quantity, referenceType: "PURCHASE", referenceId: purchase.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });
      const batchCondition = batchId ? eq(stockBalances.batchId, batchId) : isNull(stockBalances.batchId);
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, warehouse.id), batchCondition) });
      const nextQuantity = decimalToUnits(balance?.quantityOnHand ?? "0") + decimalToUnits(line.quantity);
      if (balance) await tx.update(stockBalances).set({ quantityOnHand: unitsToDecimal(nextQuantity), updatedAt: new Date() }).where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, warehouse.id), batchCondition));
      else await tx.insert(stockBalances).values({ tenantId: ctx.tenantId, itemId: item.id, warehouseId: warehouse.id, batchId, quantityOnHand: line.quantity, weightedAvgCost: line.costPrice });
    }
    if (paidUnits > 0n) {
      const paymentId = crypto.randomUUID();
      await tx.insert(payments).values({ id: paymentId, tenantId: ctx.tenantId, partyType: "SUPPLIER", partyId: input.supplierId, direction: "OUT", amount: paidTotal, method: "CASH", operationId: crypto.randomUUID(), createdBy: ctx.userId });
      await tx.insert(paymentAllocations).values({ tenantId: ctx.tenantId, paymentId, allocatedToType: "PURCHASE", allocatedToId: purchase.id, amount: paidTotal });
    }
    if (grandTotalUnits > paidUnits) await tx.insert(payables).values({ tenantId: ctx.tenantId, supplierId: input.supplierId, purchaseId: purchase.id, amount: grandTotal, paidAmount: paidTotal, balance: dueTotal, status: paidUnits === 0n ? "OPEN" : "PARTIAL" });
    return purchase;
  });
}

export async function listPurchases(ctx: TenantContext, filters: SearchPurchasesQuery & { q?: string; limit?: number; offset?: number }) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.purchases.findMany({
    where: and(eq(purchases.tenantId, ctx.tenantId), filters.supplierId ? eq(purchases.supplierId, filters.supplierId) : undefined, filters.branchId ? eq(purchases.branchId, filters.branchId) : undefined, filters.status ? eq(purchases.status, filters.status) : undefined, filters.dateFrom ? gte(purchases.purchaseDate, new Date(filters.dateFrom)) : undefined, filters.dateTo ? lte(purchases.purchaseDate, new Date(filters.dateTo)) : undefined, filters.q ? ilike(purchases.purchaseNumber, `%${filters.q}%`) : undefined),
    orderBy: [desc(purchases.purchaseDate)], limit: Math.min(filters.limit ?? 50, 100), offset: filters.offset ?? 0,
  }));
}

export async function getPurchase(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const purchase = await tx.query.purchases.findFirst({ where: and(eq(purchases.id, id), eq(purchases.tenantId, ctx.tenantId)) });
    if (!purchase) throw new AppError("RESOURCE_NOT_FOUND", "Purchase not found");
    const [lines, movements, payable] = await Promise.all([
      tx.query.purchaseItems.findMany({ where: and(eq(purchaseItems.purchaseId, id), eq(purchaseItems.tenantId, ctx.tenantId)), orderBy: [asc(purchaseItems.createdAt)] }),
      tx.query.stockMovements.findMany({ where: and(eq(stockMovements.referenceType, "PURCHASE"), eq(stockMovements.referenceId, id), eq(stockMovements.tenantId, ctx.tenantId)) }),
      tx.query.payables.findFirst({ where: and(eq(payables.purchaseId, id), eq(payables.tenantId, ctx.tenantId)) }),
    ]);
    return { purchase, lines, movements, payable };
  });
}