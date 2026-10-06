/**
 * Van/Route Sales — Field Sale hook for `CompleteSaleUseCase`
 * (30_MODULE_VAN_SALES.md §4.3, Decisions VAN-012 / VAN-013,
 * registered in 07 §7.6a). Kept in this module's own file so
 * sale.ts only contains thin, documented call sites (hook position
 * "4.5b" for the availability check, and a conditional branch inside
 * step 7), never Van-Sales business logic itself.
 *
 * WHY step 7 is branched (Decision VAN-012): stock handed to a rep
 * already LEFT warehouse on-hand at issue time (REP_ISSUE, and the
 * value moved 1200 -> 1250). A field sale therefore must NOT post a
 * second core `SALE` movement / decrement core.stock_balances, and its
 * COGS must relieve 1250, not 1200 -- otherwise warehouse stock and
 * Inventory would be reduced twice while Stock With Sales Reps never
 * unwinds. Same class of problem as Service's inventoryAlreadyDeducted
 * (15 §6), same narrow-branch remedy.
 *
 * Field-sale detection (Decision VAN-013): EXPLICIT `repAssignmentId`
 * on the sale input, not inferred from "actor happens to hold an
 * assignment" -- a rep (or a Manager who is also a rep) can still ring
 * up an ordinary warehouse-counter sale. The id is not trusted: the
 * server verifies it is the ACTOR's OWN, ISSUED, same-branch
 * assignment.
 */
import { and, eq, isNull } from "drizzle-orm";
import { repCustodyBalances, repStockAssignmentLines, repStockAssignments, repStockMovements } from "@erp/db";
import type { Database } from "@erp/db";
import { AppError } from "@erp/shared";
import type { TenantContext } from "../guard";

const moneyScale = 10000n;
function toUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole ?? "0") * moneyScale + BigInt(fraction.padEnd(4, "0").slice(0, 4));
}
function fromUnits(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % moneyScale).toString().padStart(4, "0").replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${absolute / moneyScale}${fraction ? `.${fraction}` : ""}`;
}

export type FieldSaleContext = { assignment: typeof repStockAssignments.$inferSelect };

type SaleShape = { repAssignmentId?: string; branchId: string; lines: Array<{ warehouseId: string; serialId?: string }> };

/** Returns null for an ordinary sale. Throws if a repAssignmentId is supplied but not valid for THIS actor. */
export async function resolveFieldSale(tx: Database, ctx: TenantContext, input: SaleShape): Promise<FieldSaleContext | null> {
  if (!input.repAssignmentId) return null;
  const assignment = await tx.query.repStockAssignments.findFirst({
    where: and(eq(repStockAssignments.id, input.repAssignmentId), eq(repStockAssignments.tenantId, ctx.tenantId)),
  });
  // 404-style for a foreign/nonexistent id (13 §3.2: never confirm existence across a boundary).
  if (!assignment) throw new AppError("RESOURCE_NOT_FOUND", "Rep stock assignment not found");
  if (assignment.repMembershipId !== ctx.membershipId) throw new AppError("RESOURCE_NOT_FOUND", "Rep stock assignment not found");
  if (assignment.status !== "ISSUED") throw new AppError("VALIDATION_FAILED", `Assignment is ${assignment.status}; only an ISSUED assignment can be sold from`);
  if (assignment.branchId !== input.branchId) throw new AppError("VALIDATION_FAILED", "Assignment belongs to a different branch");
  if (input.lines.some((line) => line.warehouseId !== assignment.warehouseId)) throw new AppError("VALIDATION_FAILED", "Field-sale lines must use the assignment's warehouse");
  if (input.lines.some((line) => line.serialId)) throw new AppError("VALIDATION_FAILED", "Serial-tracked items cannot be sold from rep custody");
  return { assignment };
}

function custodyKeyCondition(ctx: TenantContext, repMembershipId: string, itemId: string, batchId: string | null | undefined) {
  return and(
    eq(repCustodyBalances.tenantId, ctx.tenantId),
    eq(repCustodyBalances.repMembershipId, repMembershipId),
    eq(repCustodyBalances.itemId, itemId),
    batchId ? eq(repCustodyBalances.batchId, batchId) : isNull(repCustodyBalances.batchId),
  );
}

/** Hook 4.5b: the rep cannot sell more than they carry. Aggregates repeated item/batch lines and row-locks each custody balance. */
export async function assertCustodyAvailability(
  tx: Database,
  ctx: TenantContext,
  fs: FieldSaleContext,
  entries: Array<{ item: { id: string; name: string; stockTracked: boolean }; input: { batchId?: string; quantity: string } }>,
) {
  const requested = new Map<string, { itemId: string; name: string; batchId?: string; units: bigint }>();
  for (const entry of entries) {
    if (!entry.item.stockTracked) continue;
    const key = `${entry.item.id}:${entry.input.batchId ?? ""}`;
    const current = requested.get(key);
    requested.set(key, { itemId: entry.item.id, name: entry.item.name, batchId: entry.input.batchId, units: (current?.units ?? 0n) + toUnits(entry.input.quantity) });
  }
  for (const need of requested.values()) {
    const rows = await tx.select().from(repCustodyBalances).where(custodyKeyCondition(ctx, fs.assignment.repMembershipId, need.itemId, need.batchId)).for("update");
    const available = toUnits(rows[0]?.quantityOnHand ?? "0");
    if (available < need.units) {
      throw new AppError("INSUFFICIENT_STOCK", `Rep is not carrying enough ${need.name}`, { itemId: need.itemId, batchId: need.batchId ?? null, inCustody: fromUnits(available), requested: fromUnits(need.units) });
    }
  }
}

/** Step 7 (field-sale branch): decrement custody + post the custody-ledger SALE movement. No core movement (VAN-012). */
export async function postFieldSaleLine(
  tx: Database,
  ctx: TenantContext,
  fs: FieldSaleContext,
  saleId: string,
  entry: { item: { id: string }; input: { batchId?: string; quantity: string } },
) {
  const condition = custodyKeyCondition(ctx, fs.assignment.repMembershipId, entry.item.id, entry.input.batchId);
  const [balance] = await tx.select().from(repCustodyBalances).where(condition).for("update");
  const next = toUnits(balance?.quantityOnHand ?? "0") - toUnits(entry.input.quantity);
  if (!balance || next < 0n) throw new AppError("INSUFFICIENT_STOCK", "Rep custody balance would go negative"); // belt-and-braces after the 4.5b check
  await tx.update(repCustodyBalances).set({ quantityOnHand: fromUnits(next), updatedAt: new Date() }).where(condition);
  await tx.insert(repStockMovements).values({
    tenantId: ctx.tenantId,
    assignmentId: fs.assignment.id,
    itemId: entry.item.id,
    batchId: entry.input.batchId,
    movementType: "SALE",
    quantity: `-${entry.input.quantity}`,
    referenceType: "SALE",
    referenceId: saleId,
    operationId: crypto.randomUUID(),
  });
}

/**
 * Decision VAN-014: the cost at which this item/batch entered the rep's custody (the unit-cost
 * snapshot recorded on the assignment line at issue). Every relief of 1250 -- field-sale COGS,
 * custody write-off, reconciliation return -- must use THIS cost so 1250 nets to zero per
 * assignment regardless of later WAC movement. Returns integer units (4 dp), like toUnits().
 * A rep holds at most one active assignment (VAN-009), so an (assignment, item, batch) key is
 * unambiguous; duplicate lines for one key share one cost because issue reads it from one balance row.
 */
export async function custodyUnitCostUnits(tx: Database, ctx: TenantContext, assignmentId: string, itemId: string, batchId: string | null | undefined): Promise<bigint> {
  const line = await tx.query.repStockAssignmentLines.findFirst({
    where: and(
      eq(repStockAssignmentLines.tenantId, ctx.tenantId),
      eq(repStockAssignmentLines.assignmentId, assignmentId),
      eq(repStockAssignmentLines.itemId, itemId),
      batchId ? eq(repStockAssignmentLines.batchId, batchId) : isNull(repStockAssignmentLines.batchId),
    ),
  });
  if (!line) throw new AppError("VALIDATION_FAILED", "Item/batch is not part of this rep stock assignment", { assignmentId, itemId, batchId: batchId ?? null });
  return toUnits(line.unitCost);
}
