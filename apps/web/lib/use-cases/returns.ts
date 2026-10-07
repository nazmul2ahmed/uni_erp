import { and, asc, eq, isNull } from "drizzle-orm";
import {
  accounts,
  items,
  journalEntries,
  journals,
  payables,
  purchases,
  purchaseItems,
  receivables,
  repStockMovements,
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
import { postCustomerReturnJournal, postSupplierReturnJournal } from "../accounting";
import { recordAudit } from "../audit";
import { roundRatio } from "../money";

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

function sumAmounts(rows: Array<{ lineTotal: string }>): bigint {
  return rows.reduce((total, row) => total + units(row.lineTotal), 0n);
}

function requestedLineIds(lines: Array<{ sourceLineId: string }>) {
  const ids = new Set<string>();
  for (const line of lines) {
    if (ids.has(line.sourceLineId)) {
      throw new AppError("VALIDATION_FAILED", "A return request cannot contain the same source line more than once");
    }
    ids.add(line.sourceLineId);
  }
}

function allocateReturnAmount(total: bigint, quantity: bigint, remainingQuantity: bigint): bigint {
  return quantity === remainingQuantity ? total : total * quantity / remainingQuantity;
}

function returnSnapshot(
  sourceQuantity: string,
  sourceSubtotal: bigint,
  sourceTax: bigint,
  prior: Array<{ quantity: string; lineTotal: string; taxAmount: string }>,
  quantity: bigint,
  requestedQuantity: string,
) {
  const returnedQuantity = sumQuantities(prior);
  const remainingQuantity = units(sourceQuantity) - returnedQuantity;
  if (quantity > remainingQuantity) {
    throw new AppError("RETURN_QTY_EXCEEDED", "Return quantity exceeds the remaining source quantity", {
      requested: requestedQuantity,
      remaining: decimal(remainingQuantity),
    });
  }
  const returnedGrand = sumAmounts(prior);
  const returnedTax = prior.reduce((total, row) => total + units(row.taxAmount), 0n);
  const remainingSubtotal = sourceSubtotal - (returnedGrand - returnedTax);
  const remainingTax = sourceTax - returnedTax;
  if (remainingQuantity < 0n || remainingSubtotal < 0n || remainingTax < 0n) {
    throw new AppError("VALIDATION_FAILED", "Existing returns exceed the source line's refundable amount");
  }
  const subtotal = allocateReturnAmount(remainingSubtotal, quantity, remainingQuantity);
  const tax = allocateReturnAmount(remainingTax, quantity, remainingQuantity);
  return { subtotal, tax, total: subtotal + tax };
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

/**
 * Cost lookup for return-side COGS reversal (08 §5.5/§5.6). Mirrors
 * sale.ts's fallback chain: specific-identification via the batch's
 * own cost_price when the line is batch-tracked (09 §6.1's "specific
 * identification" path), else the item/warehouse's tracked weighted-
 * average cost, else the item's current purchasePrice. This is a
 * documented approximation for non-batch items (it uses the CURRENT
 * WAC/purchasePrice, not necessarily the cost at the time of the
 * original sale/purchase, since per-line cost is not persisted on
 * sale_items/purchase_items) -- flagged in the accompanying review
 * report, not silently upgraded to full historical costing here.
 */
async function lineCostUnits(tx: Database, ctx: TenantContext, itemId: string, warehouseId: string, batchId: string | null): Promise<bigint> {
  if (batchId) {
    const batch = await tx.query.stockBatches.findFirst({ where: and(eq(stockBatches.id, batchId), eq(stockBatches.tenantId, ctx.tenantId)) });
    if (batch?.costPrice) return units(batch.costPrice);
  }
  const batchCondition = batchId ? eq(stockBalances.batchId, batchId) : isNull(stockBalances.batchId);
  const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, itemId), eq(stockBalances.warehouseId, warehouseId), batchCondition) });
  if (balance?.weightedAvgCost) return units(balance.weightedAvgCost);
  const item = await tx.query.items.findFirst({ where: and(eq(items.id, itemId), eq(items.tenantId, ctx.tenantId)) });
  return units(item?.purchasePrice ?? "0");
}

export async function completeCustomerReturn(ctx: TenantContext, input: CustomerReturnInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const replay = await tx.query.returns.findFirst({ where: and(eq(returns.tenantId, ctx.tenantId), eq(returns.operationId, operationId)) });
    if (replay) return replay;
    await assertWarehouse(tx, ctx, input.warehouseId);
    const [sale] = await tx.select().from(sales)
      .where(and(eq(sales.id, input.saleId), eq(sales.tenantId, ctx.tenantId)))
      .for("update");
    if (!sale || !sale.customerId) throw new AppError("RESOURCE_NOT_FOUND", "Sale not found or has no customer");
    if (sale.status === "CANCELLED") throw new AppError("VALIDATION_FAILED", "A cancelled sale cannot be returned");
    // Van Sales guard (Decision VAN-012): a field sale drew from rep custody, not the
    // warehouse. Returning it through this flow would put stock back into warehouse
    // on-hand and debit Inventory 1200 for goods that never left it via this sale.
    // The dedicated field-return flow (30 §5.3) is not implemented yet -> refuse rather
    // than post wrong ledger entries.
    const fieldSaleMovement = await tx.query.repStockMovements.findFirst({ where: and(eq(repStockMovements.tenantId, ctx.tenantId), eq(repStockMovements.movementType, "SALE"), eq(repStockMovements.referenceId, sale.id)) });
    if (fieldSaleMovement) throw new AppError("VALIDATION_FAILED", "This sale was made from rep custody; use the field return flow (30 §5.3)", { saleId: sale.id });
    requestedLineIds(input.lines);
    const sourceLines = await tx.select().from(saleItems).where(and(eq(saleItems.saleId, sale.id), eq(saleItems.tenantId, ctx.tenantId))).orderBy(asc(saleItems.id)).for("update");
    const selected = [] as Array<{ source: typeof sourceLines[number] & { batchId: string | null }; quantity: bigint; subtotal: bigint; tax: bigint; total: bigint; condition: "RESELLABLE" | "UNSELLABLE" }>;
    for (const requested of input.lines) {
      const source = sourceLines.find((line) => line.id === requested.sourceLineId);
      if (!source || source.warehouseId !== input.warehouseId) throw new AppError("RESOURCE_NOT_FOUND", "Sale line not found in the selected warehouse");
      const prior = await tx.query.returnLines.findMany({ where: and(eq(returnLines.tenantId, ctx.tenantId), eq(returnLines.saleItemId, source.id)) });
      const quantity = units(requested.quantity);
      const snapshot = returnSnapshot(
        source.quantity,
        units(source.lineTotal) - units(source.taxAmount) - units(source.orderDiscountAllocation),
        units(source.taxAmount),
        prior,
        quantity,
        requested.quantity,
      );
      selected.push({ source, quantity, ...snapshot, condition: requested.condition ?? "RESELLABLE" });
    }
    const subtotal = selected.reduce((sum, line) => sum + line.subtotal, 0n);
    const tax = selected.reduce((sum, line) => sum + line.tax, 0n);
    const total = subtotal + tax;
    const originalRevenue = await tx.query.journals.findFirst({
      where: and(
        eq(journals.tenantId, ctx.tenantId),
        eq(journals.referenceType, "SALE"),
        eq(journals.referenceId, sale.id),
        eq(journals.description, "Sale revenue recognition"),
      ),
    });
    if (!originalRevenue) throw new AppError("INTERNAL_ERROR", "Original sale revenue journal is missing");
    const originalSettlement = await tx.select({ code: accounts.code, debit: journalEntries.debit })
      .from(journalEntries)
      .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
      .where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journalEntries.journalId, originalRevenue.id)));
    const originalPaid = originalSettlement
      .filter((line) => line.code === "1000" || line.code === "1010")
      .reduce((sum, line) => sum + units(line.debit), 0n);
    const originalDue = originalSettlement
      .filter((line) => line.code === "1100")
      .reduce((sum, line) => sum + units(line.debit), 0n);
    const originalTotal = originalPaid + originalDue;
    const priorCustomerReturns = await tx.query.returns.findMany({
      where: and(
        eq(returns.tenantId, ctx.tenantId),
        eq(returns.saleId, sale.id),
        eq(returns.type, "CUSTOMER_RETURN"),
        eq(returns.status, "COMPLETED"),
      ),
    });
    const priorReturnedTotal = priorCustomerReturns.reduce((sum, row) => sum + units(row.grandTotal), 0n);
    const priorCashRefunded = priorCustomerReturns.reduce((sum, row) => sum + units(row.cashRefundAmount), 0n);
    const cumulativeCashTarget = originalTotal > 0n
      ? roundRatio((priorReturnedTotal + total) * originalPaid, originalTotal)
      : 0n;
    const cashRatioShare = cumulativeCashTarget > priorCashRefunded
      ? cumulativeCashTarget - priorCashRefunded
      : 0n;
    const receivableRows = await tx.select().from(receivables)
      .where(and(eq(receivables.tenantId, ctx.tenantId), eq(receivables.saleId, sale.id)))
      .for("update");
    const receivable = receivableRows[0];
    const dueRatioShare = total > cashRatioShare ? total - cashRatioShare : 0n;
    const availableReceivable = receivable ? units(receivable.balance) : 0n;
    const receivableReduction = dueRatioShare < availableReceivable ? dueRatioShare : availableReceivable;
    const cashRefund = total - receivableReduction;
    const [record] = await tx.insert(returns).values({
      tenantId: ctx.tenantId,
      type: "CUSTOMER_RETURN",
      saleId: sale.id,
      partyId: sale.customerId,
      warehouseId: input.warehouseId,
      subtotal: decimal(subtotal),
      taxTotal: decimal(tax),
      grandTotal: decimal(total),
      cashRefundAmount: decimal(cashRefund),
      receivableReductionAmount: decimal(receivableReduction),
      operationId,
      notes: input.notes,
      createdBy: ctx.userId,
    }).returning();
    if (!record) throw new AppError("INTERNAL_ERROR", "Unable to create customer return");
    let returnedCostUnits = 0n;
    let unsellableCostUnits = 0n; // Decision VAN-003
    for (const line of selected) {
      await tx.insert(returnLines).values({ tenantId: ctx.tenantId, returnId: record.id, saleItemId: line.source.id, itemId: line.source.itemId, warehouseId: line.source.warehouseId, batchId: line.source.batchId, quantity: decimal(line.quantity), unitPrice: line.source.unitPrice, lineTotal: decimal(line.total), taxAmount: decimal(line.tax), condition: line.condition });
      const item = await tx.query.items.findFirst({ where: and(eq(items.id, line.source.itemId), eq(items.tenantId, ctx.tenantId)) });
      if (!item) throw new AppError("RESOURCE_NOT_FOUND", "Item not found");
      const costUnits = await lineCostUnits(tx, ctx, line.source.itemId, line.source.warehouseId, line.source.batchId);
      const lineCostTotal = (costUnits * line.quantity) / scale;
      returnedCostUnits += lineCostTotal;
      // Reinstate to sellable stock first (financial effect is
      // IDENTICAL regardless of condition, per Decision VAN-003) --
      await updateBalance(tx, ctx, line.source.itemId, line.source.warehouseId, line.source.batchId, line.quantity, item.allowNegativeStock);
      await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: line.source.itemId, warehouseId: line.source.warehouseId, batchId: line.source.batchId, serialId: line.source.serialId, movementType: "CUSTOMER_RETURN", quantity: decimal(line.quantity), referenceType: "RETURN", referenceId: record.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });
      if (line.condition === "UNSELLABLE") {
        // ... then IMMEDIATELY write it back off (net zero on
        // stock_balances) -- per Decision VAN-003, this unit never
        // actually becomes available sellable stock.
        unsellableCostUnits += lineCostTotal;
        await updateBalance(tx, ctx, line.source.itemId, line.source.warehouseId, line.source.batchId, -line.quantity, true);
        await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: line.source.itemId, warehouseId: line.source.warehouseId, batchId: line.source.batchId, serialId: line.source.serialId, movementType: "LOSS", quantity: decimal(-line.quantity), referenceType: "RETURN", referenceId: record.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });
      }
    }
    if (receivable) {
      const nextBalance = availableReceivable - receivableReduction;
      await tx.update(receivables).set({
        amount: decimal(units(receivable.paidAmount) + nextBalance),
        balance: decimal(nextBalance),
        status: nextBalance === 0n ? "SETTLED" : "PARTIAL",
        updatedAt: new Date(),
      }).where(and(eq(receivables.id, receivable.id), eq(receivables.tenantId, ctx.tenantId)));
    }

    await postCustomerReturnJournal(tx, ctx, {
      returnId: record.id,
      operationId,
      returnedSubtotal: decimal(subtotal),
      returnedTax: decimal(tax),
      returnedGrandTotal: decimal(total),
      returnedCostTotal: decimal(returnedCostUnits),
      cashRefundAmount: decimal(cashRefund),
      receivableReductionAmount: decimal(receivableReduction),
      unsellableCostTotal: decimal(unsellableCostUnits), // Decision VAN-003
    });

    await recordAudit(tx, ctx, {
      action: "return.customer.complete",
      entityType: "RETURN",
      entityId: record.id,
      after: {
        saleId: sale.id,
        subtotal: decimal(subtotal),
        taxTotal: decimal(tax),
        grandTotal: decimal(total),
        cashRefundAmount: decimal(cashRefund),
        receivableReductionAmount: decimal(receivableReduction),
      },
    });

    return record;
  });
}

export async function completeSupplierReturn(ctx: TenantContext, input: SupplierReturnInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const replay = await tx.query.returns.findFirst({ where: and(eq(returns.tenantId, ctx.tenantId), eq(returns.operationId, operationId)) });
    if (replay) return replay;
    await assertWarehouse(tx, ctx, input.warehouseId);
    const [purchase] = await tx.select().from(purchases)
      .where(and(eq(purchases.id, input.purchaseId), eq(purchases.tenantId, ctx.tenantId)))
      .for("update");
    if (!purchase) throw new AppError("RESOURCE_NOT_FOUND", "Purchase not found");
    requestedLineIds(input.lines);
    const sourceLines = await tx.select().from(purchaseItems).where(and(eq(purchaseItems.purchaseId, purchase.id), eq(purchaseItems.tenantId, ctx.tenantId))).orderBy(asc(purchaseItems.id)).for("update");
    const selected = [] as Array<{ source: typeof sourceLines[number] & { batchId: string | null }; quantity: bigint; subtotal: bigint; tax: bigint; total: bigint }>;
    for (const requested of input.lines) {
      const source = sourceLines.find((line) => line.id === requested.sourceLineId);
      if (!source || source.warehouseId !== input.warehouseId) throw new AppError("RESOURCE_NOT_FOUND", "Purchase line not found in the selected warehouse");
      const prior = await tx.query.returnLines.findMany({ where: and(eq(returnLines.tenantId, ctx.tenantId), eq(returnLines.purchaseItemId, source.id)) });
      const quantity = units(requested.quantity);
      const snapshot = returnSnapshot(
        source.quantity,
        units(source.lineTotal) - units(source.taxAmount) - units(source.orderDiscountAllocation),
        units(source.taxAmount),
        prior,
        quantity,
        requested.quantity,
      );
      const batch = source.batchNumber ? await tx.query.stockBatches.findFirst({ where: and(eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, source.itemId), eq(stockBatches.batchNumber, source.batchNumber)) }) : null;
      selected.push({ source: { ...source, batchId: batch?.id ?? null }, quantity, ...snapshot });
    }
    const subtotal = selected.reduce((sum, line) => sum + line.subtotal, 0n);
    const tax = selected.reduce((sum, line) => sum + line.tax, 0n);
    const total = subtotal + tax;
    const originalPurchase = await tx.query.journals.findFirst({
      where: and(
        eq(journals.tenantId, ctx.tenantId),
        eq(journals.referenceType, "PURCHASE"),
        eq(journals.referenceId, purchase.id),
        eq(journals.description, "Purchase received"),
      ),
    });
    if (!originalPurchase) throw new AppError("INTERNAL_ERROR", "Original purchase journal is missing");
    const originalSettlement = await tx.select({ code: accounts.code, credit: journalEntries.credit })
      .from(journalEntries)
      .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
      .where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journalEntries.journalId, originalPurchase.id)));
    const originalPaid = originalSettlement
      .filter((line) => line.code === "1000" || line.code === "1010")
      .reduce((sum, line) => sum + units(line.credit), 0n);
    const originalDue = originalSettlement
      .filter((line) => line.code === "2000")
      .reduce((sum, line) => sum + units(line.credit), 0n);
    const originalTotal = originalPaid + originalDue;
    const priorSupplierReturns = await tx.query.returns.findMany({
      where: and(
        eq(returns.tenantId, ctx.tenantId),
        eq(returns.purchaseId, purchase.id),
        eq(returns.type, "SUPPLIER_RETURN"),
        eq(returns.status, "COMPLETED"),
      ),
    });
    const priorReturnedTotal = priorSupplierReturns.reduce((sum, row) => sum + units(row.grandTotal), 0n);
    const priorSupplierRefunded = priorSupplierReturns.reduce((sum, row) => sum + units(row.supplierRefundAmount), 0n);
    const cumulativeRefundTarget = originalTotal > 0n
      ? roundRatio((priorReturnedTotal + total) * originalPaid, originalTotal)
      : 0n;
    const cashRatioShare = cumulativeRefundTarget > priorSupplierRefunded
      ? cumulativeRefundTarget - priorSupplierRefunded
      : 0n;
    const payableRows = await tx.select().from(payables)
      .where(and(eq(payables.tenantId, ctx.tenantId), eq(payables.purchaseId, purchase.id)))
      .for("update");
    const payable = payableRows[0];
    const dueRatioShare = total > cashRatioShare ? total - cashRatioShare : 0n;
    const availablePayable = payable ? units(payable.balance) : 0n;
    const payableReduction = dueRatioShare < availablePayable ? dueRatioShare : availablePayable;
    const supplierRefund = total - payableReduction;
    const [record] = await tx.insert(returns).values({
      tenantId: ctx.tenantId,
      type: "SUPPLIER_RETURN",
      purchaseId: purchase.id,
      partyId: purchase.supplierId,
      warehouseId: input.warehouseId,
      subtotal: decimal(subtotal),
      taxTotal: decimal(tax),
      grandTotal: decimal(total),
      supplierRefundAmount: decimal(supplierRefund),
      payableReductionAmount: decimal(payableReduction),
      operationId,
      notes: input.notes,
      createdBy: ctx.userId,
    }).returning();
    if (!record) throw new AppError("INTERNAL_ERROR", "Unable to create supplier return");
    for (const line of selected) {
      await tx.insert(returnLines).values({ tenantId: ctx.tenantId, returnId: record.id, purchaseItemId: line.source.id, itemId: line.source.itemId, warehouseId: line.source.warehouseId, batchId: line.source.batchId, quantity: decimal(line.quantity), unitPrice: line.source.costPrice, lineTotal: decimal(line.total), taxAmount: decimal(line.tax) });
      const item = await tx.query.items.findFirst({ where: and(eq(items.id, line.source.itemId), eq(items.tenantId, ctx.tenantId)) });
      if (!item) throw new AppError("RESOURCE_NOT_FOUND", "Item not found");
      await updateBalance(tx, ctx, line.source.itemId, line.source.warehouseId, line.source.batchId, -line.quantity, item.allowNegativeStock);
      await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: line.source.itemId, warehouseId: line.source.warehouseId, batchId: line.source.batchId, movementType: "SUPPLIER_RETURN", quantity: decimal(-line.quantity), referenceType: "RETURN", referenceId: record.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });
    }
    if (payable) {
      const nextBalance = availablePayable - payableReduction;
      await tx.update(payables).set({
        amount: decimal(units(payable.paidAmount) + nextBalance),
        balance: decimal(nextBalance),
        status: nextBalance === 0n ? "SETTLED" : "PARTIAL",
        updatedAt: new Date(),
      }).where(and(eq(payables.id, payable.id), eq(payables.tenantId, ctx.tenantId)));
    }

    await postSupplierReturnJournal(tx, ctx, {
      returnId: record.id,
      operationId,
      returnedCostTotal: decimal(total),
      supplierRefundAmount: decimal(supplierRefund),
      payableReductionAmount: decimal(payableReduction),
    });

    await recordAudit(tx, ctx, {
      action: "return.supplier.complete",
      entityType: "RETURN",
      entityId: record.id,
      after: { purchaseId: purchase.id, grandTotal: decimal(total) },
    });

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

    await recordAudit(tx, ctx, {
      action: "inventory.adjust",
      entityType: "STOCK_ADJUSTMENT",
      entityId: record.id,
      before: { quantity: decimal(balance.previous) },
      after: { quantity: decimal(balance.resulting) },
      reason: input.reason,
    });

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