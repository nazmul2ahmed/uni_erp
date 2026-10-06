import { and, asc, desc, eq, gte, ilike, isNull, lte } from "drizzle-orm";
import {
  businessProfiles,
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
import { hasPermission } from "../guard";
import { postSaleJournal } from "../accounting";
import { recordAudit } from "../audit";
import { assertCustodyAvailability, custodyUnitCostUnits, postFieldSaleLine, resolveFieldSale } from "./field-sale";

/**
 * `DiscountThresholdPolicy` — per 07 §7.5a, Decision DOM-006.
 *
 * Resolves Open Question 07 §21 Q2. Hybrid model:
 *   - tenant-wide configurable ceiling (soft configuration, per 02 §44)
 *   - `sales.discount.override` permission bypasses the ceiling entirely
 *     for actors who hold it (no secondary "override ceiling" — the
 *     permission itself is the gate, exactly as specified in 07 §7.5a's
 *     pseudocode: "else if actor.permissions includes
 *     'sales.discount.override': ALLOW").
 *
 * The 0-100% bound on any single discountPercent is enforced upstream
 * by the existing lineTotal/grandTotal >= 0 checks in completeSale()
 * (lines 85/93 below) — that is a separate HARD invariant, unrelated
 * to this SOFT, tenant-configurable ceiling.
 *
 * IMPLEMENTATION-DEFAULT FLAGGED (not silently invented — surfaced
 * here for explicit visibility): `07` §7.5a documents `tenantCeiling
 * = tenant.settings.sales.maxDiscountPercent` as tenant-configurable
 * but does not specify a DEFAULT value for tenants that have never
 * set it (e.g. every tenant currently seeded, since
 * businessProfiles.settingsJson defaults to "{}" per
 * packages/db/schema/core.ts). A default of 20% is used here as a
 * reasonable, conservative implementation-detail assumption (per the
 * "minor implementation detail -> reasonable assumption" allowance) —
 * NOT a ratified business decision. Flagged in the accompanying
 * review report for explicit tenant-settings-API exposure in a later
 * phase, at which point tenants can override this default per-tenant.
 *
 * SCOPE NOTE (also flagged, not silently expanded): `07` §7.5a's
 * pseudocode names `line.discountPercent` specifically. This
 * implementation applies the IDENTICAL ceiling/override check to the
 * order-level discount (`orderDiscount`) as well — omitting it would
 * let any actor trivially bypass the entire policy by moving a
 * would-be line discount into the order-level field instead. This is
 * flagged here as a recommended clarifying amendment to 07 §7.5a
 * (extending its scope from "lines" to "lines + order"), not
 * something silently decided; the review report calls this out
 * explicitly for your sign-off.
 */
const DEFAULT_MAX_DISCOUNT_PERCENT = 20;
const DISCOUNT_OVERRIDE_PERMISSION = "sales.discount.override";

/**
 * Decision VAN-007 (30_MODULE_VAN_SALES.md §8) — ceiling resolution
 * becomes role-scoped: `tenant.settings.sales.discountCeilings.
 * byRoleKey[actor.roleKey]`, falling back to `.default`, falling back
 * to DEFAULT_MAX_DISCOUNT_PERCENT. This REPLACES the single flat
 * `maxDiscountPercent` field this session originally shipped (Decision
 * DOM-006) — that field is still read for one release as a legacy
 * fallback (see resolveDiscountCeiling below) so a tenant that
 * configured ONLY the old flat field is not silently reset to the
 * default the moment this ships; new configuration should use
 * `discountCeilings` going forward (exposed via PATCH /api/tenant/
 * profile, see that route's schema).
 */
function resolveDiscountCeiling(settingsJson: string, roleKey: string): number {
  try {
    const parsed = JSON.parse(settingsJson) as {
      sales?: {
        maxDiscountPercent?: number; // legacy flat field, DOM-006
        discountCeilings?: { default?: number; byRoleKey?: Record<string, number> };
      };
    };
    const byRole = parsed?.sales?.discountCeilings?.byRoleKey?.[roleKey];
    if (typeof byRole === "number" && byRole >= 0) return byRole;
    const tenantDefault = parsed?.sales?.discountCeilings?.default;
    if (typeof tenantDefault === "number" && tenantDefault >= 0) return tenantDefault;
    const legacyFlat = parsed?.sales?.maxDiscountPercent;
    if (typeof legacyFlat === "number" && legacyFlat >= 0) return legacyFlat;
    return DEFAULT_MAX_DISCOUNT_PERCENT;
  } catch {
    // Malformed settings JSON fails closed to the conservative default
    // rather than throwing mid-sale (05 §159 Fail Closed Principle,
    // applied here as "fail to the safer/lower ceiling", not "fail
    // the whole transaction for an unrelated data-quality issue").
    return DEFAULT_MAX_DISCOUNT_PERCENT;
  }
}

/**
 * Result shape distinguishes "passed under the ceiling" from "passed
 * via override" so completeSale() can record the latter on the audit
 * entry (per 07 §7.6a's audit note accompanying this policy).
 */
function checkDiscountCeiling(discountPercentUnits: bigint, ceilingPercent: number, ctx: TenantContext, label: string): { overrideUsed: boolean } {
  const ceilingUnits = BigInt(Math.round(ceilingPercent * 100)); // percent, 2dp precision
  if (discountPercentUnits <= ceilingUnits) return { overrideUsed: false };
  if (hasPermission(ctx, DISCOUNT_OVERRIDE_PERMISSION)) return { overrideUsed: true };
  throw new AppError("DISCOUNT_EXCEEDED", `${label} discount exceeds the tenant's ${ceilingPercent}% ceiling and the actor lacks '${DISCOUNT_OVERRIDE_PERMISSION}'`, {
    ceilingPercent,
    requestedPercent: Number(discountPercentUnits) / 100,
  });
}

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

    // Van Sales hook (30 §4.3, Decisions VAN-012/VAN-013, registered in
    // 07 §7.6a): null for every ordinary sale -> all behaviour below is
    // byte-for-byte unchanged unless the caller explicitly sent a
    // repAssignmentId that belongs to them.
    const fieldSale = await resolveFieldSale(tx, ctx, input);

    // DiscountThresholdPolicy (07 §7.5a, Decision DOM-006) — load the
    // tenant's ceiling ONCE, within this transaction, before evaluating
    // any line. Per-tenant business_profiles row is guaranteed to exist
    // (created atomically at tenant onboarding, lib/tenant-onboarding.ts).
    const profile = await tx.query.businessProfiles.findFirst({ where: eq(businessProfiles.tenantId, ctx.tenantId) });
    const maxDiscountPercent = resolveDiscountCeiling(profile?.settingsJson ?? "{}", ctx.roleKey);
    let discountOverrideApplied = false;

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
      const lineSubtotalUnits = decimalToUnits(line.quantity) * decimalToUnits(item.sellingPrice) / moneyScale;
      const lineDiscountUnits = decimalToUnits(line.lineDiscount);
      const lineTotalUnits = lineSubtotalUnits - lineDiscountUnits;
      if (lineTotalUnits < 0n) throw new AppError("VALIDATION_FAILED", "Line discount cannot exceed line value", { itemId: item.id });
      if (lineDiscountUnits > 0n && lineSubtotalUnits > 0n) {
        const linePercentHundredths = (lineDiscountUnits * 10000n) / lineSubtotalUnits; // percent * 100
        const result = checkDiscountCeiling(linePercentHundredths, maxDiscountPercent, ctx, `${item.name} line`);
        if (result.overrideUsed) discountOverrideApplied = true;
      }
      computedLines.push({ input: line, item, lineTotal: unitsToDecimal(lineTotalUnits) });
    }

    const subtotalUnits = computedLines.reduce((sum, entry) => sum + decimalToUnits(entry.input.quantity) * decimalToUnits(entry.item.sellingPrice) / moneyScale, 0n);
    const orderDiscountUnits = decimalToUnits(input.orderDiscount);
    const discountUnits = computedLines.reduce((sum, entry) => sum + decimalToUnits(entry.input.lineDiscount), 0n) + orderDiscountUnits;
    const grandTotalUnits = subtotalUnits - discountUnits;
    const paidUnits = decimalToUnits(input.cashReceived);
    if (grandTotalUnits < 0n) throw new AppError("VALIDATION_FAILED", "Discounts cannot exceed the sale subtotal");
    if (paidUnits > grandTotalUnits) throw new AppError("VALIDATION_FAILED", "Payment cannot exceed the sale total");
    if (!input.customerId && paidUnits !== grandTotalUnits) throw new AppError("VALIDATION_FAILED", "A walk-in sale must be paid in full");

    // Order-level discount — same DiscountThresholdPolicy ceiling,
    // applied to the aggregate `orderDiscount` field (extends 07
    // §7.5a's scope from "lines" to "lines + order"; flagged for spec
    // sign-off per the code comment above `DiscountThresholdPolicy`).
    if (orderDiscountUnits > 0n && subtotalUnits > 0n) {
      const orderPercentHundredths = (orderDiscountUnits * 10000n) / subtotalUnits;
      const result = checkDiscountCeiling(orderPercentHundredths, maxDiscountPercent, ctx, "Order-level");
      if (result.overrideUsed) discountOverrideApplied = true;
    }

    // Hook 4.5b: availability is checked against the rep's custody, not the warehouse.
    if (fieldSale) await assertCustodyAvailability(tx, ctx, fieldSale, computedLines);

    for (const entry of computedLines) {
      if (fieldSale) break;
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

    let costOfLinesUnits = 0n;
    for (const entry of computedLines) {
      await tx.insert(saleItems).values({ tenantId: ctx.tenantId, saleId: sale.id, itemId: entry.item.id, description: entry.input.description, quantity: entry.input.quantity, unitPrice: entry.item.sellingPrice, lineDiscount: entry.input.lineDiscount, taxAmount: "0", lineTotal: entry.lineTotal, batchId: entry.input.batchId, serialId: entry.input.serialId, warehouseId: entry.input.warehouseId });
      if (!entry.item.stockTracked) continue;
      const batchCondition = entry.input.batchId ? eq(stockBalances.batchId, entry.input.batchId) : isNull(stockBalances.batchId);
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, entry.item.id), eq(stockBalances.warehouseId, entry.input.warehouseId), batchCondition) });
      const requestedUnits = decimalToUnits(entry.input.quantity);
      // COGS costing per 09 §6.1/§6.3: use the tracked weighted-average
      // cost when present (kept current by receivePurchase's balance
      // update, per 09 §6.1 Decision INV-002), falling back to the
      // item's current purchasePrice for a balance row that predates
      // WAC tracking or was never purchased through this system
      // (e.g. an opening-stock item). This is a documented
      // approximation, not full per-batch specific-identification
      // costing (09 §6.1's batch/serial path) -- flagged in the
      // accompanying review report, not silently upgraded here since
      // that would require reading entry.input.batchId's own
      // stock_batches.cost_price, a larger change than this
      // reconciliation pass's Finding A/B scope.
      // Decision VAN-014: a field sale relieves 1250 at the cost recorded when the goods were
      // issued to the rep, NOT the warehouse's current WAC -- otherwise 1250 would not net to zero.
      const costPriceUnits = fieldSale
        ? await custodyUnitCostUnits(tx, ctx, fieldSale.assignment.id, entry.item.id, entry.input.batchId)
        : balance?.weightedAvgCost ? decimalToUnits(balance.weightedAvgCost) : decimalToUnits(entry.item.purchasePrice);
      costOfLinesUnits += (costPriceUnits * requestedUnits) / moneyScale;
      if (fieldSale) {
        // Step 7, field-sale branch (Decision VAN-012): custody ledger only.
        await postFieldSaleLine(tx, ctx, fieldSale, sale.id, entry);
        continue;
      }
      const nextQuantity = decimalToUnits(balance?.quantityOnHand ?? "0") - requestedUnits;
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

    await postSaleJournal(tx, ctx, {
      saleId: sale.id,
      operationId,
      subtotal: sale.subtotal,
      discountTotal: sale.discountTotal,
      taxTotal: sale.taxTotal,
      paidTotal: sale.paidTotal,
      dueTotal: sale.dueTotal,
      costOfLinesAtCost: unitsToDecimal(costOfLinesUnits),
      inventoryAccountCode: fieldSale ? "1250" : "1200",
    });

    await recordAudit(tx, ctx, {
      action: "sale.complete",
      entityType: "SALE",
      entityId: sale.id,
      // discountOverrideApplied: per 07 §7.6a's audit note — a sale
      // that exceeded the tenant's discount ceiling and was permitted
      // only via `sales.discount.override` is a sensitive action
      // (02 §33) and must be traceable without a separate audit call.
      after: { invoiceNumber: sale.invoiceNumber, grandTotal: sale.grandTotal, status: sale.status, discountOverrideApplied, ...(fieldSale ? { repAssignmentId: fieldSale.assignment.id } : {}) },
    });

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