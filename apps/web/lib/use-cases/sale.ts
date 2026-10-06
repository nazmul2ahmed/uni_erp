import { and, asc, desc, eq, gte, ilike, isNull, lte } from "drizzle-orm";
import {
  businessProfiles,
  accounts,
  customers,
  items,
  journalEntries,
  journals,
  paymentAllocations,
  payments,
  receivables,
  repStockMovements,
  returns,
  saleItems,
  sales,
  stockBalances,
  stockBatches,
  stockSerials,
  stockMovements,
  taxProfiles,
  branches,
  warehouses,
  withTenantTransaction,
} from "@erp/db";
import { AppError } from "@erp/shared";
import type { CreateSaleInput, SearchSalesQuery } from "@erp/validation";
import type { CancelSaleInput } from "@erp/validation";
import type { Database } from "@erp/db";
import type { TenantContext } from "../guard";
import { hasPermission } from "../guard";
import { deterministicSubOperationId, postCustomerSaleRefundJournal, postReversalJournal, postSaleJournal } from "../accounting";
import { recordAudit } from "../audit";
import { allocateProportionally, decimalToUnits, moneyScale, multiplyToMoneyUnits, taxForAmount, unitsToDecimal } from "../money";
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

function saleNumber(): string {
  return `INV-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

function signedDecimalToUnits(value: string): bigint {
  return value.startsWith("-") ? -decimalToUnits(value.slice(1)) : decimalToUnits(value);
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

    const taxProfileRows = await tx.query.taxProfiles.findMany({
      where: eq(taxProfiles.tenantId, ctx.tenantId),
    });
    const taxProfileById = new Map(taxProfileRows.map((taxProfile) => [taxProfile.id, taxProfile]));
    const computedLines: Array<{
      input: CreateSaleInput["lines"][number];
      item: typeof items.$inferSelect;
      subtotalUnits: bigint;
      lineDiscountUnits: bigint;
      orderDiscountUnits: bigint;
      taxProfileId: string | null;
      taxRate: string;
      taxAmountUnits: bigint;
      lineTotalUnits: bigint;
    }> = [];
    const batchMap = new Map<string, typeof stockBatches.$inferSelect>();
    for (const line of input.lines) {
      const item = itemMap.get(line.itemId)!;
      const taxProfile = item.taxProfileId ? taxProfileById.get(item.taxProfileId) : undefined;
      if (item.taxProfileId && !taxProfile) {
        throw new AppError("VALIDATION_FAILED", `${item.name} tax profile is unavailable for this tenant`);
      }
      if (taxProfile?.isInclusive) {
        throw new AppError("VALIDATION_FAILED", `${item.name} uses an unsupported tax-inclusive profile`);
      }
      if (line.unitPrice !== item.sellingPrice) throw new AppError("VALIDATION_FAILED", `${item.name} price is no longer current`, { itemId: item.id });
      const autoFifo = !fieldSale && item.batchTracked && !item.expiryTracked && !item.serialTracked;
      if (autoFifo && line.batchId) throw new AppError("VALIDATION_FAILED", `${item.name} batches are allocated automatically using FIFO`);
      if ((item.batchTracked || item.expiryTracked) && !autoFifo && !line.batchId) throw new AppError("VALIDATION_FAILED", `${item.name} requires a batch`);
      if (!item.batchTracked && line.batchId) throw new AppError("VALIDATION_FAILED", `${item.name} does not accept a batch`);
      if (item.serialTracked && !line.serialId) throw new AppError("VALIDATION_FAILED", `${item.name} requires a serial`);
      if (!item.serialTracked && line.serialId) throw new AppError("VALIDATION_FAILED", `${item.name} does not accept a serial`);
      if (line.batchId) {
        const batch = await tx.query.stockBatches.findFirst({ where: and(eq(stockBatches.id, line.batchId), eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, item.id)) });
        if (!batch) throw new AppError("RESOURCE_NOT_FOUND", `${item.name} batch not found`);
        if (item.expiryTracked && batch.expiryDate && batch.expiryDate < new Date().toISOString().slice(0, 10)) throw new AppError("VALIDATION_FAILED", `${item.name} batch is expired`, { itemId: item.id, batchId: batch.id });
        batchMap.set(batch.id, batch);
      }
      if (line.serialId) {
        const serial = await tx.query.stockSerials.findFirst({ where: and(eq(stockSerials.id, line.serialId), eq(stockSerials.tenantId, ctx.tenantId), eq(stockSerials.itemId, item.id), eq(stockSerials.status, "IN_STOCK")) });
        if (!serial) throw new AppError("VALIDATION_FAILED", `${item.name} serial is unavailable`, { itemId: item.id, serialId: line.serialId });
      }
      const lineSubtotalUnits = multiplyToMoneyUnits(decimalToUnits(line.quantity), decimalToUnits(item.sellingPrice));
      const lineDiscountUnits = decimalToUnits(line.lineDiscount);
      if (lineSubtotalUnits - lineDiscountUnits < 0n) throw new AppError("VALIDATION_FAILED", "Line discount cannot exceed line value", { itemId: item.id });
      if (lineDiscountUnits > 0n && lineSubtotalUnits > 0n) {
        const linePercentHundredths = (lineDiscountUnits * 10000n) / lineSubtotalUnits; // percent * 100
        const result = checkDiscountCeiling(linePercentHundredths, maxDiscountPercent, ctx, `${item.name} line`);
        if (result.overrideUsed) discountOverrideApplied = true;
      }
      computedLines.push({
        input: line,
        item,
        subtotalUnits: lineSubtotalUnits,
        lineDiscountUnits,
        orderDiscountUnits: 0n,
        taxProfileId: taxProfile?.id ?? null,
        taxRate: taxProfile?.rate ?? "0",
        taxAmountUnits: 0n,
        lineTotalUnits: 0n,
      });
    }

    const subtotalUnits = computedLines.reduce((sum, entry) => sum + entry.subtotalUnits, 0n);
    const orderDiscountUnits = decimalToUnits(input.orderDiscount);
    const lineDiscountUnits = computedLines.reduce((sum, entry) => sum + entry.lineDiscountUnits, 0n);
    const discountUnits = lineDiscountUnits + orderDiscountUnits;
    if (subtotalUnits - discountUnits < 0n) throw new AppError("VALIDATION_FAILED", "Discounts cannot exceed the sale subtotal");
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
      taxTotalUnits += entry.taxAmountUnits;
    }
    const grandTotalUnits = subtotalUnits - discountUnits + taxTotalUnits;
    const paidUnits = decimalToUnits(input.cashReceived);
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

    const stockRequests = new Map<string, {
      item: typeof items.$inferSelect;
      warehouseId: string;
      batchId: string | null;
      requestedUnits: bigint;
      allocation: "FIFO" | "FIXED";
    }>();
    if (!fieldSale) {
      for (const entry of computedLines) {
        if (!entry.item.stockTracked) continue;
        const allocation = entry.item.batchTracked && !entry.item.expiryTracked && !entry.item.serialTracked ? "FIFO" : "FIXED";
        const batchId = allocation === "FIFO" ? null : entry.input.batchId ?? null;
        const key = JSON.stringify([entry.item.id, entry.input.warehouseId, allocation, batchId]);
        const existing = stockRequests.get(key);
        if (existing) {
          existing.requestedUnits += decimalToUnits(entry.input.quantity);
        } else {
          stockRequests.set(key, {
            item: entry.item,
            warehouseId: entry.input.warehouseId,
            batchId,
            requestedUnits: decimalToUnits(entry.input.quantity),
            allocation,
          });
        }
      }
    }

    // Lock every distinct balance in the same order across multi-line sales.
    const orderedStockRequests = [...stockRequests.values()].sort((a, b) =>
      a.item.id.localeCompare(b.item.id)
      || a.warehouseId.localeCompare(b.warehouseId)
      || (a.batchId ?? "").localeCompare(b.batchId ?? ""),
    );
    const fifoBalances = new Map<string, Array<{ batchId: string; availableUnits: bigint }>>();
    for (const request of orderedStockRequests) {
      if (request.allocation === "FIFO") {
        const batches = await tx.query.stockBatches.findMany({
          where: and(eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, request.item.id)),
          orderBy: [asc(stockBatches.receivedAt), asc(stockBatches.id)],
        });
        for (const batch of batches) batchMap.set(batch.id, batch);
        const balances = await tx.select().from(stockBalances)
          .where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, request.item.id), eq(stockBalances.warehouseId, request.warehouseId)))
          .orderBy(asc(stockBalances.batchId))
          .for("update");
        const balanceByBatch = new Map(balances.filter((balance) => balance.batchId).map((balance) => [balance.batchId!, balance]));
        const availableByBatch = batches.flatMap((batch) => {
          const balance = balanceByBatch.get(batch.id);
          const availableUnits = decimalToUnits(balance?.quantityOnHand ?? "0") - decimalToUnits(balance?.quantityReserved ?? "0");
          return availableUnits > 0n ? [{ batchId: batch.id, availableUnits }] : [];
        });
        const availableUnits = availableByBatch.reduce((sum, batch) => sum + batch.availableUnits, 0n);
        if (availableUnits < request.requestedUnits) throw new AppError("INSUFFICIENT_STOCK", `Insufficient stock for ${request.item.name}`, { itemId: request.item.id, available: unitsToDecimal(availableUnits), requested: unitsToDecimal(request.requestedUnits) });
        fifoBalances.set(JSON.stringify([request.item.id, request.warehouseId]), availableByBatch);
        continue;
      }
      const batchCondition = request.batchId ? eq(stockBalances.batchId, request.batchId) : isNull(stockBalances.batchId);
      const balances = await tx.select().from(stockBalances).where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, request.item.id), eq(stockBalances.warehouseId, request.warehouseId), batchCondition)).for("update");
      const balance = balances[0];
      const availableUnits = decimalToUnits(balance?.quantityOnHand ?? "0") - decimalToUnits(balance?.quantityReserved ?? "0");
      if (!request.item.allowNegativeStock && availableUnits < request.requestedUnits) throw new AppError("INSUFFICIENT_STOCK", `Insufficient stock for ${request.item.name}`, { itemId: request.item.id, batchId: request.batchId, available: unitsToDecimal(availableUnits), requested: unitsToDecimal(request.requestedUnits) });
    }

    const fifoRemaining = new Map<string, bigint>();
    for (const [key, balances] of fifoBalances) for (const balance of balances) fifoRemaining.set(`${key}:${balance.batchId}`, balance.availableUnits);
    const postedLines: typeof computedLines = [];
    for (const entry of computedLines) {
      const autoFifo = !fieldSale && entry.item.stockTracked && entry.item.batchTracked && !entry.item.expiryTracked && !entry.item.serialTracked;
      if (!autoFifo) {
        postedLines.push(entry);
        continue;
      }
      const groupKey = JSON.stringify([entry.item.id, entry.input.warehouseId]);
      const batches = fifoBalances.get(groupKey) ?? [];
      const quantityUnits = decimalToUnits(entry.input.quantity);
      const originalSubtotalUnits = entry.subtotalUnits;
      const originalDiscountUnits = entry.lineDiscountUnits;
      const originalOrderDiscountUnits = entry.orderDiscountUnits;
      const originalTaxUnits = entry.taxAmountUnits;
      let remainingUnits = quantityUnits;
      let remainingSubtotalUnits = originalSubtotalUnits;
      let remainingDiscountUnits = originalDiscountUnits;
      let remainingOrderDiscountUnits = originalOrderDiscountUnits;
      let remainingTaxUnits = originalTaxUnits;
      const allocations: Array<{ batchId: string; quantityUnits: bigint; subtotalUnits: bigint; discountUnits: bigint; orderDiscountUnits: bigint; taxAmountUnits: bigint }> = [];
      for (const batch of batches) {
        if (remainingUnits <= 0n) break;
        const key = `${groupKey}:${batch.batchId}`;
        const availableUnits = fifoRemaining.get(key) ?? 0n;
        const allocatedUnits = availableUnits < remainingUnits ? availableUnits : remainingUnits;
        if (allocatedUnits <= 0n) continue;
        const lastAllocation = allocatedUnits === remainingUnits;
        const subtotalUnits = lastAllocation ? remainingSubtotalUnits : originalSubtotalUnits * allocatedUnits / quantityUnits;
        const discountUnits = lastAllocation ? remainingDiscountUnits : originalDiscountUnits * allocatedUnits / quantityUnits;
        const orderDiscountUnits = lastAllocation ? remainingOrderDiscountUnits : originalOrderDiscountUnits * allocatedUnits / quantityUnits;
        const taxAmountUnits = lastAllocation ? remainingTaxUnits : originalTaxUnits * allocatedUnits / quantityUnits;
        allocations.push({ batchId: batch.batchId, quantityUnits: allocatedUnits, subtotalUnits, discountUnits, orderDiscountUnits, taxAmountUnits });
        fifoRemaining.set(key, availableUnits - allocatedUnits);
        remainingUnits -= allocatedUnits;
        remainingSubtotalUnits -= subtotalUnits;
        remainingDiscountUnits -= discountUnits;
        remainingOrderDiscountUnits -= orderDiscountUnits;
        remainingTaxUnits -= taxAmountUnits;
      }
      if (remainingUnits > 0n) throw new AppError("INSUFFICIENT_STOCK", `Insufficient stock for ${entry.item.name}`, { itemId: entry.item.id, requested: entry.input.quantity });
      for (const allocation of allocations) {
        postedLines.push({
          ...entry,
          input: {
            ...entry.input,
            quantity: unitsToDecimal(allocation.quantityUnits),
            lineDiscount: unitsToDecimal(allocation.discountUnits),
            batchId: allocation.batchId,
          },
          orderDiscountUnits: allocation.orderDiscountUnits,
          taxAmountUnits: allocation.taxAmountUnits,
          lineTotalUnits: allocation.subtotalUnits - allocation.discountUnits + allocation.taxAmountUnits,
        });
      }
    }

    const status = paidUnits === grandTotalUnits ? "PAID" : paidUnits > 0n ? "PARTIALLY_PAID" : "DUE";
    const [sale] = await tx.insert(sales).values({ tenantId: ctx.tenantId, branchId: input.branchId, invoiceNumber: saleNumber(), customerId: input.customerId ?? null, status, subtotal: unitsToDecimal(subtotalUnits), discountTotal: unitsToDecimal(discountUnits), taxTotal: unitsToDecimal(taxTotalUnits), grandTotal: unitsToDecimal(grandTotalUnits), paidTotal: unitsToDecimal(paidUnits), dueTotal: unitsToDecimal(grandTotalUnits - paidUnits), saleDate: input.saleDate ? new Date(input.saleDate) : new Date(), operationId, createdBy: ctx.userId }).returning();
    if (!sale) throw new AppError("INTERNAL_ERROR", "Unable to create sale");

    let costOfLinesUnits = 0n;
    for (const entry of postedLines) {
      const [saleLine] = await tx.insert(saleItems).values({ tenantId: ctx.tenantId, saleId: sale.id, itemId: entry.item.id, description: entry.input.description, quantity: entry.input.quantity, unitPrice: entry.item.sellingPrice, lineDiscount: entry.input.lineDiscount, orderDiscountAllocation: unitsToDecimal(entry.orderDiscountUnits), taxProfileId: entry.taxProfileId, taxRate: entry.taxRate, taxAmount: unitsToDecimal(entry.taxAmountUnits), lineTotal: unitsToDecimal(entry.lineTotalUnits), batchId: entry.input.batchId, serialId: entry.input.serialId, warehouseId: entry.input.warehouseId }).returning({ id: saleItems.id });
      if (!saleLine) throw new AppError("INTERNAL_ERROR", "Unable to create sale line");
      if (entry.input.serialId) {
        const [serial] = await tx.update(stockSerials)
          .set({ status: "SOLD", saleItemId: saleLine.id, updatedAt: new Date() })
          .where(and(eq(stockSerials.id, entry.input.serialId), eq(stockSerials.tenantId, ctx.tenantId), eq(stockSerials.status, "IN_STOCK")))
          .returning({ id: stockSerials.id });
        if (!serial) throw new AppError("VALIDATION_FAILED", "Serial is no longer available for this sale", { serialId: entry.input.serialId });
      }
      if (!entry.item.stockTracked) continue;
      const batchCondition = entry.input.batchId ? eq(stockBalances.batchId, entry.input.batchId) : isNull(stockBalances.batchId);
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, entry.item.id), eq(stockBalances.warehouseId, entry.input.warehouseId), batchCondition) });
      const requestedUnits = decimalToUnits(entry.input.quantity);
      // Batch-valued stock uses the consumed batch's specific cost; other
      // stock uses WAC, falling back to the item's purchase price for
      // opening balances without a recorded WAC.
      // Decision VAN-014: a field sale relieves 1250 at the cost recorded when the goods were
      // issued to the rep, NOT the warehouse's current WAC -- otherwise 1250 would not net to zero.
      const costPriceUnits = fieldSale
        ? await custodyUnitCostUnits(tx, ctx, fieldSale.assignment.id, entry.item.id, entry.input.batchId)
        : entry.input.batchId && batchMap.get(entry.input.batchId)
          ? decimalToUnits(batchMap.get(entry.input.batchId)!.costPrice)
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

export async function cancelSale(ctx: TenantContext, id: string, input: CancelSaleInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const priorOperation = await tx.query.sales.findFirst({
      where: and(eq(sales.tenantId, ctx.tenantId), eq(sales.cancelOperationId, operationId)),
    });
    if (priorOperation && priorOperation.id !== id) {
      throw new AppError("VALIDATION_FAILED", "Idempotency-Key has already been used for another sale cancellation");
    }

    const [sale] = await tx.select().from(sales)
      .where(and(eq(sales.id, id), eq(sales.tenantId, ctx.tenantId)))
      .for("update");
    if (!sale) throw new AppError("RESOURCE_NOT_FOUND", "Sale not found");
    if (sale.status === "CANCELLED") {
      if (sale.cancelOperationId === operationId) return sale;
      throw new AppError("VALIDATION_FAILED", "Sale has already been cancelled");
    }
    if (!["DUE", "PARTIALLY_PAID", "PAID", "COMPLETED"].includes(sale.status)) {
      throw new AppError("VALIDATION_FAILED", "Only a completed sale can be cancelled");
    }

    const fieldSale = await tx.query.repStockMovements.findFirst({
      where: and(
        eq(repStockMovements.tenantId, ctx.tenantId),
        eq(repStockMovements.movementType, "SALE"),
        eq(repStockMovements.referenceType, "SALE"),
        eq(repStockMovements.referenceId, sale.id),
      ),
    });
    if (fieldSale) {
      throw new AppError("VALIDATION_FAILED", "Field sales cannot be cancelled through the warehouse sale flow");
    }

    const priorReturns = await tx.query.returns.findFirst({
      where: and(
        eq(returns.tenantId, ctx.tenantId),
        eq(returns.saleId, sale.id),
        eq(returns.type, "CUSTOMER_RETURN"),
        eq(returns.status, "COMPLETED"),
      ),
    });
    if (priorReturns) {
      throw new AppError("VALIDATION_FAILED", "A sale with completed returns cannot be cancelled");
    }

    const saleLines = await tx.select().from(saleItems)
      .where(and(eq(saleItems.tenantId, ctx.tenantId), eq(saleItems.saleId, sale.id)))
      .orderBy(asc(saleItems.id))
      .for("update");
    const movements = await tx.select().from(stockMovements)
      .where(and(
        eq(stockMovements.tenantId, ctx.tenantId),
        eq(stockMovements.movementType, "SALE"),
        eq(stockMovements.referenceType, "SALE"),
        eq(stockMovements.referenceId, sale.id),
      ))
      .orderBy(asc(stockMovements.itemId), asc(stockMovements.warehouseId), asc(stockMovements.batchId), asc(stockMovements.id));

    const movementGroups = new Map<string, typeof movements>();
    for (const movement of movements) {
      const key = `${movement.itemId}:${movement.warehouseId}:${movement.batchId ?? ""}`;
      movementGroups.set(key, [...(movementGroups.get(key) ?? []), movement]);
    }
    for (const group of movementGroups.values()) {
      const first = group[0]!;
      const batchCondition = first.batchId ? eq(stockBalances.batchId, first.batchId) : isNull(stockBalances.batchId);
      const balanceRows = await tx.select().from(stockBalances)
        .where(and(
          eq(stockBalances.tenantId, ctx.tenantId),
          eq(stockBalances.itemId, first.itemId),
          eq(stockBalances.warehouseId, first.warehouseId),
          batchCondition,
        ))
        .for("update");
      const balance = balanceRows[0];
      const restoreUnits = group.reduce((sum, movement) => {
        const quantity = signedDecimalToUnits(movement.quantity);
        if (quantity >= 0n) throw new AppError("INTERNAL_ERROR", "Sale stock movement has an invalid quantity");
        return sum - quantity;
      }, 0n);
      if (balance) {
        await tx.update(stockBalances)
          .set({ quantityOnHand: unitsToDecimal(decimalToUnits(balance.quantityOnHand) + restoreUnits), updatedAt: new Date() })
          .where(and(
            eq(stockBalances.tenantId, ctx.tenantId),
            eq(stockBalances.itemId, first.itemId),
            eq(stockBalances.warehouseId, first.warehouseId),
            batchCondition,
          ));
      } else {
        await tx.insert(stockBalances).values({
          tenantId: ctx.tenantId,
          itemId: first.itemId,
          warehouseId: first.warehouseId,
          batchId: first.batchId,
          quantityOnHand: unitsToDecimal(restoreUnits),
          weightedAvgCost: null,
        });
      }
      for (const movement of group) {
        await tx.insert(stockMovements).values({
          tenantId: ctx.tenantId,
          itemId: movement.itemId,
          warehouseId: movement.warehouseId,
          batchId: movement.batchId,
          serialId: movement.serialId,
          movementType: "ADJUSTMENT_IN",
          quantity: unitsToDecimal(-signedDecimalToUnits(movement.quantity)),
          referenceType: "SALE_CANCELLED",
          referenceId: sale.id,
          operationId: deterministicSubOperationId(operationId, `stock:${movement.id}`),
          createdBy: ctx.userId,
        });
      }
    }

    for (const line of saleLines) {
      if (!line.serialId) continue;
      const serialRows = await tx.select().from(stockSerials)
        .where(and(eq(stockSerials.id, line.serialId), eq(stockSerials.tenantId, ctx.tenantId)))
        .for("update");
      const serial = serialRows[0];
      if (!serial) throw new AppError("INTERNAL_ERROR", "Sale serial record is missing");
      if (serial.status === "SOLD" && serial.saleItemId === line.id) {
        await tx.update(stockSerials)
          .set({ status: "IN_STOCK", saleItemId: null, updatedAt: new Date() })
          .where(and(eq(stockSerials.id, serial.id), eq(stockSerials.tenantId, ctx.tenantId)));
      } else if (serial.status !== "IN_STOCK" || serial.saleItemId !== null) {
        throw new AppError("VALIDATION_FAILED", "A sale serial is no longer available to restore", { serialId: line.serialId });
      }
    }

    const originalJournals = await tx.query.journals.findMany({
      where: and(
        eq(journals.tenantId, ctx.tenantId),
        eq(journals.referenceType, "SALE"),
        eq(journals.referenceId, sale.id),
      ),
    });
    const revenueJournals = originalJournals.filter((journal) => journal.description === "Sale revenue recognition");
    const cogsJournals = originalJournals.filter((journal) => journal.description === "Sale cost of goods sold");
    if (revenueJournals.length !== 1 || cogsJournals.length > 1) {
      throw new AppError("INTERNAL_ERROR", "Sale accounting journals are missing or ambiguous");
    }

    const revenueJournal = revenueJournals[0]!;
    const revenueEntries = await tx.select({ code: accounts.code, debit: journalEntries.debit })
      .from(journalEntries)
      .innerJoin(accounts, eq(accounts.id, journalEntries.accountId))
      .where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journalEntries.journalId, revenueJournal.id)));
    const initialRefundMethods = revenueEntries
      .filter((entry) => (entry.code === "1000" || entry.code === "1010") && decimalToUnits(entry.debit) > 0n)
      .map((entry) => ({
        method: entry.code === "1000" ? "CASH" as const : "BANK" as const,
        amount: decimalToUnits(entry.debit),
      }));
    const initialPaidUnits = initialRefundMethods.reduce((sum, entry) => sum + entry.amount, 0n);

    const allocationRows = sale.customerId
      ? await tx.select({
          paymentId: payments.id,
          partyType: payments.partyType,
          partyId: payments.partyId,
          direction: payments.direction,
          amount: payments.amount,
          method: payments.method,
          allocationAmount: paymentAllocations.amount,
        })
          .from(paymentAllocations)
          .innerJoin(payments, eq(payments.id, paymentAllocations.paymentId))
          .where(and(
            eq(paymentAllocations.tenantId, ctx.tenantId),
            eq(paymentAllocations.allocatedToType, "SALE"),
            eq(paymentAllocations.allocatedToId, sale.id),
            eq(payments.tenantId, ctx.tenantId),
            eq(payments.direction, "IN"),
          ))
          .orderBy(asc(payments.createdAt), asc(payments.id), asc(paymentAllocations.id))
      : [];

    let refundRows = allocationRows;
    if (sale.customerId && initialPaidUnits > 0n) {
      const initialPayment = allocationRows[0];
      if (
        !initialPayment
        || initialPayment.partyType !== "CUSTOMER"
        || initialPayment.partyId !== sale.customerId
        || decimalToUnits(initialPayment.amount) !== initialPaidUnits
        || decimalToUnits(initialPayment.allocationAmount) !== initialPaidUnits
      ) {
        throw new AppError("INTERNAL_ERROR", "Initial sale payment allocation does not match its accounting journal");
      }
      refundRows = allocationRows.slice(1);
    }

    const refundsByPayment = new Map<string, {
      partyId: string;
      method: (typeof payments.$inferSelect)["method"];
      amount: bigint;
    }>();
    for (const row of refundRows) {
      if (row.partyType !== "CUSTOMER" || row.partyId !== sale.customerId) {
        throw new AppError("INTERNAL_ERROR", "Sale payment allocation belongs to a different customer");
      }
      const current = refundsByPayment.get(row.paymentId);
      refundsByPayment.set(row.paymentId, {
        partyId: row.partyId,
        method: row.method,
        amount: (current?.amount ?? 0n) + decimalToUnits(row.allocationAmount),
      });
    }
    const totalRefundUnits = [...refundsByPayment.values()].reduce((sum, refund) => sum + refund.amount, 0n);
    if (sale.customerId && totalRefundUnits !== decimalToUnits(sale.paidTotal) - initialPaidUnits) {
      throw new AppError("INTERNAL_ERROR", "Allocated sale payments do not match the recorded paid total");
    }

    const receivable = await tx.query.receivables.findFirst({
      where: and(eq(receivables.tenantId, ctx.tenantId), eq(receivables.saleId, sale.id)),
    });
    if (receivable) {
      if (
        decimalToUnits(receivable.balance) !== decimalToUnits(sale.dueTotal)
        || decimalToUnits(receivable.paidAmount) !== decimalToUnits(sale.paidTotal)
      ) {
        throw new AppError("INTERNAL_ERROR", "Sale receivable does not match the recorded sale balance");
      }
      await tx.update(receivables)
        .set({ balance: "0", status: "CANCELLED", updatedAt: new Date() })
        .where(and(eq(receivables.id, receivable.id), eq(receivables.tenantId, ctx.tenantId)));
    } else if (decimalToUnits(sale.dueTotal) > 0n) {
      throw new AppError("INTERNAL_ERROR", "Sale has an outstanding balance but no receivable");
    }

    const reversalJournals = [];
    for (const journal of [...revenueJournals, ...cogsJournals]) {
      const reversal = await postReversalJournal(tx, ctx, {
        originalJournalId: journal.id,
        operationId: deterministicSubOperationId(operationId, `journal:${journal.id}`),
        reason: input.reason,
      });
      reversalJournals.push(reversal.id);
    }

    const refundPaymentIds: string[] = [];
    if (sale.customerId) {
      for (const [index, refund] of initialRefundMethods.entries()) {
        const [refundPayment] = await tx.insert(payments).values({
          tenantId: ctx.tenantId,
          partyType: "CUSTOMER",
          partyId: sale.customerId,
          direction: "OUT",
          amount: unitsToDecimal(refund.amount),
          method: refund.method,
          operationId: deterministicSubOperationId(operationId, `refund:initial:${index}`),
          createdBy: ctx.userId,
        }).returning();
        if (!refundPayment) throw new AppError("INTERNAL_ERROR", "Unable to record initial sale refund");
        await tx.insert(paymentAllocations).values({
          tenantId: ctx.tenantId,
          paymentId: refundPayment.id,
          allocatedToType: "SALE",
          allocatedToId: sale.id,
          amount: unitsToDecimal(refund.amount),
        });
        refundPaymentIds.push(refundPayment.id);
      }
    }
    for (const [paymentId, refund] of refundsByPayment) {
      const refundAmount = unitsToDecimal(refund.amount);
      const refundOperationId = deterministicSubOperationId(operationId, `refund:${paymentId}`);
      const [refundPayment] = await tx.insert(payments).values({
        tenantId: ctx.tenantId,
        partyType: "CUSTOMER",
        partyId: refund.partyId,
        direction: "OUT",
        amount: refundAmount,
        method: refund.method,
        operationId: refundOperationId,
        createdBy: ctx.userId,
      }).returning();
      if (!refundPayment) throw new AppError("INTERNAL_ERROR", "Unable to record sale refund");
      await tx.insert(paymentAllocations).values({
        tenantId: ctx.tenantId,
        paymentId: refundPayment.id,
        allocatedToType: "SALE",
        allocatedToId: sale.id,
        amount: refundAmount,
      });
      await postCustomerSaleRefundJournal(tx, ctx, {
        paymentId: refundPayment.id,
        operationId: deterministicSubOperationId(operationId, `refund-journal:${paymentId}`),
        amount: refundAmount,
        method: refund.method,
      });
      refundPaymentIds.push(refundPayment.id);
    }

    const [cancelledSale] = await tx.update(sales)
      .set({
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledReason: input.reason,
        cancelOperationId: operationId,
        updatedAt: new Date(),
        updatedBy: ctx.userId,
      })
      .where(and(eq(sales.id, sale.id), eq(sales.tenantId, ctx.tenantId)))
      .returning();
    if (!cancelledSale) throw new AppError("INTERNAL_ERROR", "Unable to cancel sale");

    await recordAudit(tx, ctx, {
      action: "sale.cancel",
      entityType: "SALE",
      entityId: sale.id,
      before: { status: sale.status, paidTotal: sale.paidTotal, dueTotal: sale.dueTotal },
      after: {
        status: cancelledSale.status,
        refundTotal: unitsToDecimal(totalRefundUnits + initialPaidUnits),
        refundPaymentIds,
        reversalJournalIds: reversalJournals,
      },
      reason: input.reason,
    });

    return cancelledSale;
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