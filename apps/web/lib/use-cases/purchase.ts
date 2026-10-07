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
  taxProfiles,
  suppliers,
  items,
  warehouses,
  branches,
  withTenantTransaction,
} from "@erp/db";
import { AppError } from "@erp/shared";
import type { CreatePurchaseInput, SearchPurchasesQuery } from "@erp/validation";
import type { TenantContext } from "../guard";
import { postPurchaseJournal } from "../accounting";
import { recordAudit } from "../audit";
import { allocateProportionally, decimalToUnits, moneyScale, multiplyToMoneyUnits, roundRatio, taxForAmount, unitsToDecimal } from "../money";

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
    const taxProfileRows = await tx.query.taxProfiles.findMany({
      where: eq(taxProfiles.tenantId, ctx.tenantId),
    });
    const taxProfileById = new Map(taxProfileRows.map((taxProfile) => [taxProfile.id, taxProfile]));
    const computedLines = input.lines.map((line) => {
      const item = itemMap.get(line.itemId)!;
      const taxProfile = item.taxProfileId ? taxProfileById.get(item.taxProfileId) : undefined;
      if (item.taxProfileId && !taxProfile) {
        throw new AppError("VALIDATION_FAILED", `${item.name} tax profile is unavailable for this tenant`);
      }
      if (taxProfile?.isInclusive) {
        throw new AppError("VALIDATION_FAILED", `${item.name} uses an unsupported tax-inclusive profile`);
      }
      if ((item.batchTracked || item.expiryTracked) && !line.batchNumber) throw new AppError("VALIDATION_FAILED", `${item.name} requires a batch number`);
      if (item.expiryTracked && !line.expiryDate) throw new AppError("VALIDATION_FAILED", `${item.name} requires an expiry date`);
      if (line.expiryDate && input.purchaseDate && line.expiryDate < input.purchaseDate.slice(0, 10)) throw new AppError("VALIDATION_FAILED", `${item.name} expiry cannot be before the purchase date`);
      const subtotalUnits = multiplyToMoneyUnits(decimalToUnits(line.quantity), decimalToUnits(line.costPrice));
      const lineDiscountUnits = decimalToUnits(line.lineDiscount);
      if (subtotalUnits - lineDiscountUnits < 0n) throw new AppError("VALIDATION_FAILED", "Line discount cannot exceed line value");
      return {
        line,
        item,
        warehouse: warehouseMap.get(line.warehouseId)!,
        subtotalUnits,
        lineDiscountUnits,
        orderDiscountUnits: 0n,
        taxProfileId: taxProfile?.id ?? null,
        taxRate: taxProfile?.rate ?? "0",
        taxAmountUnits: 0n,
        lineTotalUnits: 0n,
        inventoryCostUnits: 0n,
        inventoryUnitCostUnits: 0n,
      };
    });
    const subtotalUnits = computedLines.reduce((sum, entry) => sum + entry.subtotalUnits, 0n);
    const lineDiscountUnits = computedLines.reduce((sum, entry) => sum + entry.lineDiscountUnits, 0n);
    const orderDiscountUnits = decimalToUnits(input.orderDiscount);
    const discountUnits = lineDiscountUnits + orderDiscountUnits;
    if (subtotalUnits - discountUnits < 0n) throw new AppError("VALIDATION_FAILED", "Discounts cannot exceed the purchase subtotal");
    const orderDiscountAllocations = allocateProportionally(
      orderDiscountUnits,
      computedLines.map((entry) => entry.subtotalUnits - entry.lineDiscountUnits),
    );
    let taxTotalUnits = 0n;
    for (const [index, entry] of computedLines.entries()) {
      entry.orderDiscountUnits = orderDiscountAllocations[index]!;
      const taxableUnits = entry.subtotalUnits - entry.lineDiscountUnits - entry.orderDiscountUnits;
      entry.taxAmountUnits = taxForAmount(taxableUnits, entry.taxRate);
      entry.lineTotalUnits = entry.subtotalUnits - entry.lineDiscountUnits + entry.taxAmountUnits;
      entry.inventoryCostUnits = taxableUnits + entry.taxAmountUnits;
      entry.inventoryUnitCostUnits = roundRatio(
        entry.inventoryCostUnits * moneyScale,
        decimalToUnits(entry.line.quantity),
      );
      taxTotalUnits += entry.taxAmountUnits;
    }
    const grandTotalUnits = subtotalUnits - discountUnits + taxTotalUnits;
    const paidUnits = decimalToUnits(input.cashPaid);
    if (paidUnits > grandTotalUnits) throw new AppError("VALIDATION_FAILED", "Payment cannot exceed the purchase total");
    const grandTotal = unitsToDecimal(grandTotalUnits);
    const paidTotal = unitsToDecimal(paidUnits);
    const dueTotal = unitsToDecimal(grandTotalUnits - paidUnits);
    const status = paidUnits === grandTotalUnits ? "PAID" : paidUnits > 0n ? "PARTIALLY_PAID" : "RECEIVED";
    const [purchase] = await tx.insert(purchases).values({
      tenantId: ctx.tenantId, branchId: input.branchId, purchaseNumber: purchaseNumber(), supplierId: input.supplierId,
      status, subtotal: unitsToDecimal(subtotalUnits), discountTotal: unitsToDecimal(discountUnits),
      taxTotal: unitsToDecimal(taxTotalUnits), grandTotal, paidTotal, dueTotal, purchaseDate: input.purchaseDate ? new Date(input.purchaseDate) : new Date(), operationId, createdBy: ctx.userId,
    }).returning();
    if (!purchase) throw new AppError("INTERNAL_ERROR", "Unable to create purchase");

    for (const entry of computedLines) {
      const { line, item, warehouse } = entry;
      let batchId: string | null = null;
      if (line.batchNumber) {
        const existingBatch = await tx.query.stockBatches.findFirst({ where: and(eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, item.id), eq(stockBatches.batchNumber, line.batchNumber)) });
        if (existingBatch) batchId = existingBatch.id;
        else {
          const [batch] = await tx.insert(stockBatches).values({ tenantId: ctx.tenantId, itemId: item.id, batchNumber: line.batchNumber, expiryDate: line.expiryDate, supplierId: input.supplierId, costPrice: unitsToDecimal(entry.inventoryUnitCostUnits) }).returning({ id: stockBatches.id });
          batchId = batch!.id;
        }
      }
      await tx.insert(purchaseItems).values({ tenantId: ctx.tenantId, purchaseId: purchase.id, itemId: item.id, description: line.description, quantity: line.quantity, costPrice: line.costPrice, sellingPrice: line.sellingPrice, lineDiscount: line.lineDiscount, orderDiscountAllocation: unitsToDecimal(entry.orderDiscountUnits), taxProfileId: entry.taxProfileId, taxRate: entry.taxRate, taxAmount: unitsToDecimal(entry.taxAmountUnits), lineTotal: unitsToDecimal(entry.lineTotalUnits), batchNumber: line.batchNumber, expiryDate: line.expiryDate, warehouseId: warehouse.id });
      await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: item.id, warehouseId: warehouse.id, batchId, movementType: "PURCHASE", quantity: line.quantity, referenceType: "PURCHASE", referenceId: purchase.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });
      const batchCondition = batchId ? eq(stockBalances.batchId, batchId) : isNull(stockBalances.batchId);
      const [balance] = await tx.select().from(stockBalances)
        .where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, warehouse.id), batchCondition))
        .for("update");
      const priorQuantityUnits = decimalToUnits(balance?.quantityOnHand ?? "0");
      const purchasedUnits = decimalToUnits(line.quantity);
      const nextQuantity = priorQuantityUnits + purchasedUnits;

      // Weighted Average Cost -- 09 §6.1, Decision INV-002: recomputed
      // on every PURCHASE movement for non-batch/serial items; left
      // null for batch-tracked rows, which use specific identification
      // via stock_batches.cost_price instead (06 v2.0 §5.10 note:
      // "null for batch/serial-valued items").
      let nextWeightedAvgCost: string | null = null;
      if (!batchId) {
        const priorCostUnits = balance?.weightedAvgCost ? decimalToUnits(balance.weightedAvgCost) : entry.inventoryUnitCostUnits;
        const priorValueUnits = multiplyToMoneyUnits(priorQuantityUnits, priorCostUnits);
        const purchaseValueUnits = entry.inventoryCostUnits;
        const nextValueUnits = priorValueUnits + purchaseValueUnits;
        nextWeightedAvgCost = nextQuantity > 0n ? unitsToDecimal(roundRatio(nextValueUnits * moneyScale, nextQuantity)) : unitsToDecimal(entry.inventoryUnitCostUnits);
      }

      if (batchId) {
        const [batch] = await tx.select().from(stockBatches)
          .where(and(eq(stockBatches.id, batchId), eq(stockBatches.tenantId, ctx.tenantId)))
          .for("update");
        if (!batch) throw new AppError("RESOURCE_NOT_FOUND", `${item.name} batch not found`);
        const batchBalances = await tx.select().from(stockBalances)
          .where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.batchId, batchId)))
          .for("update");
        const priorBatchQuantity = batchBalances.reduce((sum, row) => sum + decimalToUnits(row.quantityOnHand), 0n);
        const priorBatchValue = multiplyToMoneyUnits(priorBatchQuantity, decimalToUnits(batch.costPrice));
        const nextBatchUnitCost = roundRatio(
          (priorBatchValue + entry.inventoryCostUnits) * moneyScale,
          priorBatchQuantity + purchasedUnits,
        );
        await tx.update(stockBatches).set({ costPrice: unitsToDecimal(nextBatchUnitCost) })
          .where(and(eq(stockBatches.id, batchId), eq(stockBatches.tenantId, ctx.tenantId)));
      }

      if (balance) await tx.update(stockBalances).set({ quantityOnHand: unitsToDecimal(nextQuantity), weightedAvgCost: nextWeightedAvgCost, updatedAt: new Date() }).where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, warehouse.id), batchCondition));
      else await tx.insert(stockBalances).values({ tenantId: ctx.tenantId, itemId: item.id, warehouseId: warehouse.id, batchId, quantityOnHand: line.quantity, weightedAvgCost: nextWeightedAvgCost });

      // Keep items.purchasePrice as "last cost" (06 v2.0 §5.6 column
      // comment) so a later Sale's COGS fallback (sale.ts, when no
      // weightedAvgCost/batch is available) reflects the most recent
      // purchase rather than a stale onboarding-time default.
      await tx.update(items).set({ purchasePrice: unitsToDecimal(entry.inventoryUnitCostUnits), updatedAt: new Date() }).where(and(eq(items.id, item.id), eq(items.tenantId, ctx.tenantId)));
    }
    if (paidUnits > 0n) {
      const paymentId = crypto.randomUUID();
      await tx.insert(payments).values({ id: paymentId, tenantId: ctx.tenantId, partyType: "SUPPLIER", partyId: input.supplierId, direction: "OUT", amount: paidTotal, method: "CASH", operationId: crypto.randomUUID(), createdBy: ctx.userId });
      await tx.insert(paymentAllocations).values({ tenantId: ctx.tenantId, paymentId, allocatedToType: "PURCHASE", allocatedToId: purchase.id, amount: paidTotal });
    }
    if (grandTotalUnits > paidUnits) await tx.insert(payables).values({ tenantId: ctx.tenantId, supplierId: input.supplierId, purchaseId: purchase.id, amount: grandTotal, paidAmount: paidTotal, balance: dueTotal, status: paidUnits === 0n ? "OPEN" : "PARTIAL" });

    await postPurchaseJournal(tx, ctx, {
      purchaseId: purchase.id,
      operationId,
      // Per 08 §5.2, Dr Inventory must net to paidTotal+dueTotal for
      // the journal to balance (grandTotal, i.e. net of discount) --
      // NOT subtotal (pre-discount). 08 §5.2's separate "Discount
      // Received" credit line is explicitly an open question in the
      // spec itself (08 §12 Q1: expense-side vs. true contra-cost
      // presentation) -- this posts Inventory at net acquisition cost
      // and omits that still-undecided line rather than guessing.
      costTotal: purchase.grandTotal,
      paidTotal: purchase.paidTotal,
      dueTotal: purchase.dueTotal,
      postedAt: purchase.purchaseDate,
    });

    await recordAudit(tx, ctx, {
      action: "purchase.receive",
      entityType: "PURCHASE",
      entityId: purchase.id,
      after: { purchaseNumber: purchase.purchaseNumber, grandTotal: purchase.grandTotal, status: purchase.status },
    });

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