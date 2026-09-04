import { and, asc, desc, eq, gte, ilike, isNull, lte } from "drizzle-orm";
import {
  customers,
  items,
  paymentAllocations,
  payments,
  receivables,
  saleItems,
  sales,
  stockBalances,
  stockBatches,
  stockSerials,
  stockMovements,
  branches,
  warehouses,
  withTenantTransaction,
} from "@erp/db";
import { AppError } from "@erp/shared";
import type { CreateSaleInput, SearchSalesQuery } from "@erp/validation";
import type { Database } from "@erp/db";
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

function saleNumber(): string {
  return `INV-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

async function assertReferences(tx: Database, ctx: TenantContext, input: CreateSaleInput) {
  const branch = await tx.query.branches.findFirst({ where: and(eq(branches.id, input.branchId), eq(branches.tenantId, ctx.tenantId), eq(branches.isActive, true)) });
  if (!branch) throw new AppError("RESOURCE_NOT_FOUND", "Branch not found or inactive");

  if (input.customerId) {
    const customer = await tx.query.customers.findFirst({ where: and(eq(customers.id, input.customerId), eq(customers.tenantId, ctx.tenantId), eq(customers.isActive, true)) });
    if (!customer) throw new AppError("RESOURCE_NOT_FOUND", "Customer not found or inactive");
  }

  const warehouseRows = await tx.query.warehouses.findMany({ where: and(eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.isActive, true)) });
  const warehouseMap = new Map(warehouseRows.map((warehouse) => [warehouse.id, warehouse]));
  const itemRows = await tx.query.items.findMany({ where: and(eq(items.tenantId, ctx.tenantId), eq(items.isActive, true)) });
  const itemMap = new Map(itemRows.filter((item) => input.lines.some((line) => line.itemId === item.id)).map((item) => [item.id, item]));
  if (itemMap.size !== new Set(input.lines.map((line) => line.itemId)).size) throw new AppError("RESOURCE_NOT_FOUND", "One or more items are unavailable");
  if (input.lines.some((line) => warehouseMap.get(line.warehouseId)?.branchId !== branch.id)) throw new AppError("VALIDATION_FAILED", "Every warehouse must belong to the selected branch");
  return { itemMap, warehouseMap };
}

export async function completeSale(ctx: TenantContext, input: CreateSaleInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const existing = await tx.query.sales.findFirst({ where: and(eq(sales.tenantId, ctx.tenantId), eq(sales.operationId, operationId)) });
    if (existing) return existing;

    const { itemMap, warehouseMap } = await assertReferences(tx, ctx, input);
    const computedLines = [] as Array<{ input: CreateSaleInput["lines"][number]; item: typeof items.$inferSelect; lineTotal: string }>;
    for (const line of input.lines) {
      const item = itemMap.get(line.itemId)!;
      if (line.unitPrice !== item.sellingPrice) throw new AppError("VALIDATION_FAILED", `${item.name} price is no longer current`, { itemId: item.id });
      if ((item.batchTracked || item.expiryTracked) && !line.batchId) throw new AppError("VALIDATION_FAILED", `${item.name} requires a batch`);
      if (!item.batchTracked && line.batchId) throw new AppError("VALIDATION_FAILED", `${item.name} does not accept a batch`);
      if (item.serialTracked && !line.serialId) throw new AppError("VALIDATION_FAILED", `${item.name} requires a serial`);
      if (!item.serialTracked && line.serialId) throw new AppError("VALIDATION_FAILED", `${item.name} does not accept a serial`);
      if (line.batchId) {
        const batch = await tx.query.stockBatches.findFirst({ where: and(eq(stockBatches.id, line.batchId), eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, item.id)) });
        if (!batch) throw new AppError("RESOURCE_NOT_FOUND", `${item.name} batch not found`);
        if (item.expiryTracked && batch.expiryDate && batch.expiryDate < new Date().toISOString().slice(0, 10)) throw new AppError("VALIDATION_FAILED", `${item.name} batch is expired`, { itemId: item.id, batchId: batch.id });
      }
      if (line.serialId) {
        const serial = await tx.query.stockSerials.findFirst({ where: and(eq(stockSerials.id, line.serialId), eq(stockSerials.tenantId, ctx.tenantId), eq(stockSerials.itemId, item.id), eq(stockSerials.status, "IN_STOCK")) });
        if (!serial) throw new AppError("VALIDATION_FAILED", `${item.name} serial is unavailable`, { itemId: item.id, serialId: line.serialId });
      }
      const lineTotalUnits = decimalToUnits(line.quantity) * decimalToUnits(item.sellingPrice) / moneyScale - decimalToUnits(line.lineDiscount);
      if (lineTotalUnits < 0n) throw new AppError("VALIDATION_FAILED", "Line discount cannot exceed line value", { itemId: item.id });
      computedLines.push({ input: line, item, lineTotal: unitsToDecimal(lineTotalUnits) });
    }

    const subtotalUnits = computedLines.reduce((sum, entry) => sum + decimalToUnits(entry.input.quantity) * decimalToUnits(entry.item.sellingPrice) / moneyScale, 0n);
    const discountUnits = computedLines.reduce((sum, entry) => sum + decimalToUnits(entry.input.lineDiscount), 0n) + decimalToUnits(input.orderDiscount);
    const grandTotalUnits = subtotalUnits - discountUnits;
    const paidUnits = decimalToUnits(input.cashReceived);
    if (grandTotalUnits < 0n) throw new AppError("VALIDATION_FAILED", "Discounts cannot exceed the sale subtotal");
    if (paidUnits > grandTotalUnits) throw new AppError("VALIDATION_FAILED", "Payment cannot exceed the sale total");
    if (!input.customerId && paidUnits !== grandTotalUnits) throw new AppError("VALIDATION_FAILED", "A walk-in sale must be paid in full");

    for (const entry of computedLines) {
      if (!entry.item.stockTracked) continue;
      const batchCondition = entry.input.batchId ? eq(stockBalances.batchId, entry.input.batchId) : isNull(stockBalances.batchId);
      const balances = await tx.select().from(stockBalances).where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, entry.item.id), eq(stockBalances.warehouseId, entry.input.warehouseId), batchCondition)).for("update");
      const balance = balances[0];
      const availableUnits = decimalToUnits(balance?.quantityOnHand ?? "0") - decimalToUnits(balance?.quantityReserved ?? "0");
      const requestedUnits = decimalToUnits(entry.input.quantity);
      if (!entry.item.allowNegativeStock && availableUnits < requestedUnits) throw new AppError("VALIDATION_FAILED", `Insufficient stock for ${entry.item.name}`, { itemId: entry.item.id, batchId: entry.input.batchId ?? null, available: unitsToDecimal(availableUnits), requested: entry.input.quantity });
    }

    const status = paidUnits === grandTotalUnits ? "PAID" : paidUnits > 0n ? "PARTIALLY_PAID" : "DUE";
    const [sale] = await tx.insert(sales).values({ tenantId: ctx.tenantId, branchId: input.branchId, invoiceNumber: saleNumber(), customerId: input.customerId ?? null, status, subtotal: unitsToDecimal(subtotalUnits), discountTotal: unitsToDecimal(discountUnits), taxTotal: "0", grandTotal: unitsToDecimal(grandTotalUnits), paidTotal: unitsToDecimal(paidUnits), dueTotal: unitsToDecimal(grandTotalUnits - paidUnits), saleDate: input.saleDate ? new Date(input.saleDate) : new Date(), operationId, createdBy: ctx.userId }).returning();
    if (!sale) throw new AppError("INTERNAL_ERROR", "Unable to create sale");

    for (const entry of computedLines) {
      await tx.insert(saleItems).values({ tenantId: ctx.tenantId, saleId: sale.id, itemId: entry.item.id, description: entry.input.description, quantity: entry.input.quantity, unitPrice: entry.item.sellingPrice, lineDiscount: entry.input.lineDiscount, taxAmount: "0", lineTotal: entry.lineTotal, batchId: entry.input.batchId, serialId: entry.input.serialId, warehouseId: entry.input.warehouseId });
      if (!entry.item.stockTracked) continue;
      const batchCondition = entry.input.batchId ? eq(stockBalances.batchId, entry.input.batchId) : isNull(stockBalances.batchId);
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, entry.item.id), eq(stockBalances.warehouseId, entry.input.warehouseId), batchCondition) });
      const nextQuantity = decimalToUnits(balance?.quantityOnHand ?? "0") - decimalToUnits(entry.input.quantity);
      if (balance) await tx.update(stockBalances).set({ quantityOnHand: unitsToDecimal(nextQuantity), updatedAt: new Date() }).where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, entry.item.id), eq(stockBalances.warehouseId, entry.input.warehouseId), batchCondition));
      else await tx.insert(stockBalances).values({ tenantId: ctx.tenantId, itemId: entry.item.id, warehouseId: entry.input.warehouseId, batchId: entry.input.batchId || null, quantityOnHand: unitsToDecimal(nextQuantity), weightedAvgCost: null });
      await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: entry.item.id, warehouseId: entry.input.warehouseId, batchId: entry.input.batchId, serialId: entry.input.serialId, movementType: "SALE", quantity: `-${entry.input.quantity}`, referenceType: "SALE", referenceId: sale.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });
    }
    const paidTotal = unitsToDecimal(paidUnits);
    if (paidUnits > 0n && input.customerId) {
      const [payment] = await tx.insert(payments).values({ tenantId: ctx.tenantId, partyType: "CUSTOMER", partyId: input.customerId, direction: "IN", amount: paidTotal, method: "CASH", operationId: crypto.randomUUID(), createdBy: ctx.userId }).returning();
      if (payment) await tx.insert(paymentAllocations).values({ tenantId: ctx.tenantId, paymentId: payment.id, allocatedToType: "SALE", allocatedToId: sale.id, amount: paidTotal });
    }
    if (input.customerId && grandTotalUnits > paidUnits) await tx.insert(receivables).values({ tenantId: ctx.tenantId, customerId: input.customerId, saleId: sale.id, amount: sale.grandTotal, paidAmount: sale.paidTotal, balance: sale.dueTotal, status: paidUnits === 0n ? "OPEN" : "PARTIAL" });
    return sale;
  });
}

export async function listSales(ctx: TenantContext, filters: SearchSalesQuery & { q?: string; limit?: number; offset?: number }) {
  return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.sales.findMany({ where: and(eq(sales.tenantId, ctx.tenantId), filters.customerId ? eq(sales.customerId, filters.customerId) : undefined, filters.branchId ? eq(sales.branchId, filters.branchId) : undefined, filters.status ? eq(sales.status, filters.status) : undefined, filters.dateFrom ? gte(sales.saleDate, new Date(filters.dateFrom)) : undefined, filters.dateTo ? lte(sales.saleDate, new Date(filters.dateTo)) : undefined, filters.q ? ilike(sales.invoiceNumber, `%${filters.q}%`) : undefined), orderBy: [desc(sales.saleDate)], limit: Math.min(filters.limit ?? 50, 100), offset: filters.offset ?? 0 }));
}

export async function getSale(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const sale = await tx.query.sales.findFirst({ where: and(eq(sales.id, id), eq(sales.tenantId, ctx.tenantId)) });
    if (!sale) throw new AppError("RESOURCE_NOT_FOUND", "Sale not found");
    const [lines, paymentsForSale, receivable] = await Promise.all([
      tx.query.saleItems.findMany({ where: and(eq(saleItems.saleId, id), eq(saleItems.tenantId, ctx.tenantId)), orderBy: [asc(saleItems.createdAt)] }),
      tx.query.paymentAllocations.findMany({ where: and(eq(paymentAllocations.allocatedToType, "SALE"), eq(paymentAllocations.allocatedToId, id), eq(paymentAllocations.tenantId, ctx.tenantId)) }),
      tx.query.receivables.findFirst({ where: and(eq(receivables.saleId, id), eq(receivables.tenantId, ctx.tenantId)) }),
    ]);
    return { sale, lines, payments: paymentsForSale, receivable };
  });
}