/**
 * Van/Route Sales — `IssueRepStockUseCase`.
 * Per `30_MODULE_VAN_SALES.md` §4.2 (10-step procedure) — Phase 4,
 * first use case in the dependency-ordered sequence (§13): every
 * later Phase-4 use case (field-sale custody-check hook, Flow 1/2
 * returns, ReconcileRepAssignmentUseCase) reads a `RepStockAssignment`
 * this use case creates.
 *
 * Ordering note (deliberate deviation from §4.2's literal step
 * numbering, not a scope change): §4.2 lists "persist RepStockAssignment"
 * as step 9, after the per-line movement postings (steps 6-7). This
 * use case creates the `RepStockAssignment` row BEFORE looping over
 * lines instead, so `core.stock_movements.reference_id` and
 * `modules.rep_stock_movements.reference_id` can carry the real
 * assignment id from the start (mirrors sale.ts's own ordering: `sale`
 * is inserted before its `saleItems`/movements loop, for the same
 * traceability reason). This is safe because the whole procedure runs
 * inside ONE atomic transaction (`withTenantTransaction`) regardless
 * of insert order — a failure anywhere still rolls back everything,
 * including the assignment row, so no orphan is ever possible.
 *
 * Allocation mode (flagged, not silently decided — see
 * packages/validation/rep-stock.ts's docblock for the full trace):
 * this use case validates a CALLER-SUPPLIED `batchId` per line
 * (Manual mode, 09 §4.5) rather than calling an
 * `AllocationStrategy.selectStockFor(...)` auto-selector — no such
 * abstraction exists anywhere in this codebase; completeSale() and
 * receivePurchase() both operate the same way. §4.2 step 5's own
 * Input shape (`batchId?` as a caller field) is consistent with this.
 *
 * Cross-domain touchpoints, none of which duplicate existing logic
 * (29 §6.1):
 *   - `resolvePermissions` (../guard) — reused verbatim to check the
 *     REP's role, not just the caller's (ctx.permissions is the
 *     CALLER's, e.g. a Manager issuing stock to a Staff-role rep —
 *     the rep's own permission set is a SEPARATE lookup, step 2).
 *   - `postRepIssueJournal` (../accounting) — Decision VAN-005.
 *   - `recordAudit` (../audit).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  branches,
  items,
  repStockAssignments,
  repStockAssignmentLines,
  repStockMovements,
  repCustodyBalances,
  stockBalances,
  stockBatches,
  stockMovements,
  warehouses,
  withTenantTransaction,
} from "@erp/db";
import type { Database } from "@erp/db";
import { AppError } from "@erp/shared";
import type { IssueRepStockInput, RecordCustodyWriteOffInput } from "@erp/validation";
import type { TenantContext } from "../guard";
import { requirePermission, resolvePermissions } from "../guard";
import { deterministicSubOperationId, postCustodyWriteOffJournal, postRepIssueJournal } from "../accounting";
import { recordAudit } from "../audit";
import { custodyUnitCostUnits } from "./field-sale";

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

const VAN_SALES_REP_PERMISSION = "sales.create"; // §4.2 step 2
// NOTE: declared but not currently consumed by this use case — see the
// "Steps 3-4" block below for why (the DB-level `rep_one_active_assignment`
// partial unique index has no override carve-out, so this permission
// cannot currently unlock a second concurrent assignment here). Kept
// as the canonical permission-key constant so a future use case
// (e.g. a force-reconcile action) references the SAME string rather
// than a second hardcoded copy drifting from it.
const VAN_SALES_OVERRIDE_PERMISSION = "vansales.override"; // Decision VAN-008

export async function issueRepStock(ctx: TenantContext, input: IssueRepStockInput, operationId: string) {
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    // Step 1 — idempotency check.
    const existingAssignment = await tx.query.repStockAssignments.findFirst({
      where: and(eq(repStockAssignments.tenantId, ctx.tenantId), eq(repStockAssignments.operationId, operationId)),
    });
    if (existingAssignment) return existingAssignment;

    // Step 2 — repMembershipId belongs to tenant, ACTIVE, holds sales.create.
    // control.memberships carries no RLS (05 §11-13) — explicit tenantId
    // filter here is the application-layer substitute, same discipline
    // lib/use-cases/staff.ts already established for this exact table.
    const repMembership = await tx.query.memberships.findFirst({
      where: (m, { and: a, eq: e }) => a(e(m.id, input.repMembershipId), e(m.tenantId, ctx.tenantId), e(m.status, "ACTIVE")),
    });
    if (!repMembership) throw new AppError("RESOURCE_NOT_FOUND", "Field rep membership not found or inactive");
    const repPermissions = await resolvePermissions(repMembership.roleId);
    if (!repPermissions.includes(VAN_SALES_REP_PERMISSION)) {
      throw new AppError("VALIDATION_FAILED", "Field rep's role does not include sales.create", { repMembershipId: input.repMembershipId });
    }

    // Steps 3-4 (Decisions VAN-009/VAN-008) — SPECIFICATION AMBIGUITY
    // FOUND AND FLAGGED (per ways-of-working: "halt at architectural
    // boundaries requiring human sign-off" — not silently resolved).
    //
    // §4.2's literal step order (3 then 4) reads as if VAN-009 ("reject
    // if ANY active ISSUED/RECONCILING assignment exists for this rep")
    // is UNCONDITIONAL, while VAN-008 layers an `vansales.override`
    // bypass on the narrower "overdue" case. But VAN-009 is ALSO
    // enforced as a DATABASE-LEVEL partial unique index
    // (`rep_one_active_assignment`, §9, "mirrors Decision INV-008's...
    // defense-in-depth pattern" — i.e. meant as a hard, unconditional
    // invariant, not a business rule with an exception). That index has
    // NO carve-out for `vansales.override` — so letting override bypass
    // the application-layer check here would not actually allow a
    // second assignment to be created; it would just convert a clean
    // ASSIGNMENT_OVERDUE business error into a raw, uncaught Postgres
    // unique-violation (23505) at the INSERT below. That would be
    // strictly worse, not an actual capability unlock.
    //
    // Resolution implemented here (the conservative, DB-invariant-
    // respecting reading): VAN-009 stays unconditional — no
    // `vansales.override` value can make a second active assignment
    // insertable while the DB constraint has no exception for it.
    // `vansales.override`'s only observable effect in THIS use case is
    // therefore which error code is returned (a caller WITHOUT the
    // permission sees the same ASSIGNMENT_OVERDUE message either way;
    // this reading does not currently make the permission unlock
    // anything here). This is flagged, not silently decided — if the
    // intended behavior was instead "override also force-transitions
    // the stale assignment out of ISSUED/RECONCILING (e.g. into
    // RECONCILING) as a side effect, THEN creates the new one," that
    // is a materially different, larger behavior this use case does
    // NOT implement, and needs an explicit decision before it's added.
    const activeAssignment = await tx.query.repStockAssignments.findFirst({
      where: (a, { and: an, eq: e, inArray: i }) => an(e(a.tenantId, ctx.tenantId), e(a.repMembershipId, input.repMembershipId), i(a.status, ["ISSUED", "RECONCILING"])),
    });
    if (activeAssignment) {
      const isOverdue = !!activeAssignment.expectedReturnAt && activeAssignment.expectedReturnAt < new Date();
      if (isOverdue) {
        throw new AppError("ASSIGNMENT_OVERDUE", `Field rep has an overdue assignment (expected back ${activeAssignment.expectedReturnAt!.toISOString()}) that must be reconciled before more stock can be issued`, { assignmentId: activeAssignment.id });
      }
      throw new AppError("ASSIGNMENT_ALREADY_ACTIVE", "This field rep already holds an active (unreconciled) stock assignment", { assignmentId: activeAssignment.id });
    }

    // Reference validation — branch/warehouse ownership, mirrors
    // sale.ts's assertReferences() shape.
    const branch = await tx.query.branches.findFirst({ where: and(eq(branches.id, input.branchId), eq(branches.tenantId, ctx.tenantId), eq(branches.isActive, true)) });
    if (!branch) throw new AppError("RESOURCE_NOT_FOUND", "Branch not found or inactive");
    const warehouse = await tx.query.warehouses.findFirst({ where: and(eq(warehouses.id, input.warehouseId), eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.isActive, true)) });
    if (!warehouse) throw new AppError("RESOURCE_NOT_FOUND", "Warehouse not found or inactive");
    if (warehouse.branchId !== branch.id) throw new AppError("VALIDATION_FAILED", "Warehouse must belong to the selected branch");

    const itemRows = await tx.query.items.findMany({ where: and(eq(items.tenantId, ctx.tenantId), eq(items.isActive, true)) });
    const itemMap = new Map(itemRows.filter((item) => input.lines.some((line) => line.itemId === item.id)).map((item) => [item.id, item]));
    if (itemMap.size !== new Set(input.lines.map((line) => line.itemId)).size) throw new AppError("RESOURCE_NOT_FOUND", "One or more items are unavailable");

    // Pre-flight batch/expiry shape validation per line, BEFORE the
    // assignment row is created — so a shape error (e.g. a missing
    // required batchId) never creates an assignment at all, matching
    // sale.ts's pattern of validating every line before any insert.
    for (const line of input.lines) {
      const item = itemMap.get(line.itemId)!;
      if ((item.batchTracked || item.expiryTracked) && !line.batchId) throw new AppError("VALIDATION_FAILED", `${item.name} requires a batch`);
      if (!item.batchTracked && line.batchId) throw new AppError("VALIDATION_FAILED", `${item.name} does not accept a batch`);
      if (line.batchId) {
        const batch = await tx.query.stockBatches.findFirst({ where: and(eq(stockBatches.id, line.batchId), eq(stockBatches.tenantId, ctx.tenantId), eq(stockBatches.itemId, item.id)) });
        if (!batch) throw new AppError("RESOURCE_NOT_FOUND", `${item.name} batch not found`);
        if (item.expiryTracked && batch.expiryDate && batch.expiryDate < new Date().toISOString().slice(0, 10)) throw new AppError("VALIDATION_FAILED", `${item.name} batch is expired`, { itemId: item.id, batchId: batch.id });
      }
    }

    // Step 9 (persisted here, ahead of steps 6-8 below — see this
    // file's top docblock for why) — persist RepStockAssignment
    // (status=ISSUED); lines are inserted inside the loop below.
    const [assignment] = await tx
      .insert(repStockAssignments)
      .values({
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        repMembershipId: input.repMembershipId,
        status: "ISSUED",
        expectedReturnAt: input.expectedReturnAt ? new Date(input.expectedReturnAt) : null,
        operationId,
      })
      .returning();
    if (!assignment) throw new AppError("INTERNAL_ERROR", "Unable to create rep stock assignment");

    let costOfLinesUnits = 0n;
    for (const line of input.lines) {
      const item = itemMap.get(line.itemId)!;
      const requestedUnits = decimalToUnits(line.quantity);

      // Step 5 — availability check (Manual mode; see this file's top
      // docblock re: AllocationStrategy). Row-locked per Decision
      // INV-003's concurrency discipline, identical to sale.ts.
      const batchCondition = line.batchId ? eq(stockBalances.batchId, line.batchId) : isNull(stockBalances.batchId);
      const balances = await tx
        .select()
        .from(stockBalances)
        .where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, input.warehouseId), batchCondition))
        .for("update");
      const balance = balances[0];
      const availableUnits = decimalToUnits(balance?.quantityOnHand ?? "0") - decimalToUnits(balance?.quantityReserved ?? "0");
      if (!item.allowNegativeStock && availableUnits < requestedUnits) {
        throw new AppError("INSUFFICIENT_STOCK", `Insufficient stock for ${item.name}`, { itemId: item.id, batchId: line.batchId ?? null, available: unitsToDecimal(availableUnits), requested: line.quantity });
      }

      // Costing — WAC-if-present else purchasePrice, identical
      // fallback to sale.ts's COGS costing (09 §6.1/§6.3).
      const costPriceUnits = balance?.weightedAvgCost ? decimalToUnits(balance.weightedAvgCost) : decimalToUnits(item.purchasePrice);
      costOfLinesUnits += (costPriceUnits * requestedUnits) / moneyScale;

      // Step 6 — REP_ISSUE movement (core.stock_movements, negative) +
      // decrement core.stock_balances. This is the SAME warehouse
      // on-hand ledger every other stock-affecting use case posts to
      // (Decision DB-001) — a rep issue genuinely removes stock from
      // warehouse custody, it does not merely reserve it.
      const nextOnHand = decimalToUnits(balance?.quantityOnHand ?? "0") - requestedUnits;
      if (balance) {
        await tx.update(stockBalances).set({ quantityOnHand: unitsToDecimal(nextOnHand), updatedAt: new Date() }).where(and(eq(stockBalances.tenantId, ctx.tenantId), eq(stockBalances.itemId, item.id), eq(stockBalances.warehouseId, input.warehouseId), batchCondition));
      } else {
        await tx.insert(stockBalances).values({ tenantId: ctx.tenantId, itemId: item.id, warehouseId: input.warehouseId, batchId: line.batchId || null, quantityOnHand: unitsToDecimal(nextOnHand), weightedAvgCost: null });
      }
      await tx.insert(stockMovements).values({ tenantId: ctx.tenantId, itemId: item.id, warehouseId: input.warehouseId, batchId: line.batchId, movementType: "REP_ISSUE", quantity: `-${line.quantity}`, referenceType: "REP_STOCK_ASSIGNMENT", referenceId: assignment.id, operationId: crypto.randomUUID(), createdBy: ctx.userId });

      // repStockAssignmentLines — the assignment's own line-item record.
      await tx.insert(repStockAssignmentLines).values({ tenantId: ctx.tenantId, assignmentId: assignment.id, itemId: item.id, batchId: line.batchId, quantityIssued: line.quantity, unitCost: unitsToDecimal(costPriceUnits) }); // Decision VAN-014: cost snapshot

      // Step 7 — ISSUE movement (modules.rep_stock_movements, positive
      // custody) + upsert modules.rep_custody_balances. A SEPARATE
      // ledger from core.stock_movements/core.stock_balances above —
      // Decision VAN-001: a rep's custody is never conflated with
      // warehouse on-hand stock.
      await tx.insert(repStockMovements).values({ tenantId: ctx.tenantId, assignmentId: assignment.id, itemId: item.id, batchId: line.batchId, movementType: "ISSUE", quantity: line.quantity, referenceType: "CUSTODY", referenceId: assignment.id, operationId: crypto.randomUUID() });

      const custodyBatchCondition = line.batchId ? eq(repCustodyBalances.batchId, line.batchId) : isNull(repCustodyBalances.batchId);
      const custodyBalance = await tx.query.repCustodyBalances.findFirst({ where: and(eq(repCustodyBalances.tenantId, ctx.tenantId), eq(repCustodyBalances.repMembershipId, input.repMembershipId), eq(repCustodyBalances.itemId, item.id), custodyBatchCondition) });
      const nextCustodyOnHand = decimalToUnits(custodyBalance?.quantityOnHand ?? "0") + requestedUnits;
      if (custodyBalance) {
        await tx.update(repCustodyBalances).set({ quantityOnHand: unitsToDecimal(nextCustodyOnHand), updatedAt: new Date() }).where(and(eq(repCustodyBalances.tenantId, ctx.tenantId), eq(repCustodyBalances.repMembershipId, input.repMembershipId), eq(repCustodyBalances.itemId, item.id), custodyBatchCondition));
      } else {
        await tx.insert(repCustodyBalances).values({ tenantId: ctx.tenantId, repMembershipId: input.repMembershipId, itemId: item.id, batchId: line.batchId || null, quantityOnHand: unitsToDecimal(nextCustodyOnHand) });
      }
    }

    // Step 8 — Dr Stock With Sales Reps (1250) / Cr Inventory (1200), at cost.
    await postRepIssueJournal(tx, ctx, {
      assignmentId: assignment.id,
      operationId,
      costTotal: unitsToDecimal(costOfLinesUnits),
    });

    // Step 10 — audit log.
    await recordAudit(tx, ctx, {
      action: "rep_stock.issue",
      entityType: "REP_STOCK_ASSIGNMENT",
      entityId: assignment.id,
      after: { repMembershipId: input.repMembershipId, warehouseId: input.warehouseId, lineCount: input.lines.length, costTotal: unitsToDecimal(costOfLinesUnits) },
    });

    return assignment;
  });
}

export async function getRepStockAssignment(ctx: TenantContext, id: string) {
  return withTenantTransaction(ctx.tenantId, async (tx: Database) => {
    const assignment = await tx.query.repStockAssignments.findFirst({ where: and(eq(repStockAssignments.id, id), eq(repStockAssignments.tenantId, ctx.tenantId)) });
    if (!assignment) throw new AppError("RESOURCE_NOT_FOUND", "Rep stock assignment not found");
    const lines = await tx.query.repStockAssignmentLines.findMany({ where: and(eq(repStockAssignmentLines.assignmentId, id), eq(repStockAssignmentLines.tenantId, ctx.tenantId)) });
    return { assignment, lines };
  });
}

const VAN_SALES_WRITEOFF_PERMISSION = "vansales.writeoff"; // Decision VAN-015

/**
 * Flow 1 -- `RecordCustodyWriteOffUseCase` (30 §5.1). Stock found damaged/expired WHILE STILL
 * WITH THE REP, before any sale.
 *
 *   1. Caller must hold `vansales.writeoff` (Decision VAN-015; OWNER/MANAGER, never the rep role).
 *   2. Assignment must be ISSUED (Decision VAN-016 -- no write-off against a closed/reconciling
 *      assignment); the row is locked so a write-off cannot race a status transition.
 *   3. Per line, in order: quantity <= modules.rep_custody_balances.quantityOnHand (row-locked).
 *   4. RETURN_DAMAGED / RETURN_EXPIRED movement (custody ledger ONLY -- core.stock_balances and
 *      core.stock_movements are never touched, 30 §4.1).
 *   5. Dr 5500 / Cr 1250 at the ISSUE-TIME cost snapshot (Decision VAN-014). No revenue journal.
 *   6. Audit (sensitive -- stock write-off, 02 §33).
 *
 * Idempotency: each line's movement carries a deterministic operationId derived from the caller's
 * operationId, so replaying the same Idempotency-Key returns the original movements and posts
 * nothing twice; reusing the key against a different assignment is rejected, not silently accepted.
 */
export async function recordCustodyWriteOff(ctx: TenantContext, input: RecordCustodyWriteOffInput, operationId: string) {
  await requirePermission(ctx, VAN_SALES_WRITEOFF_PERMISSION);
  return withTenantTransaction(ctx.tenantId, async (tx) => {
    const lineOperationIds = input.lines.map((_, index) => deterministicSubOperationId(operationId, `writeoff:${index}`));

    // Idempotency replay.
    const replayed = await tx.query.repStockMovements.findFirst({ where: and(eq(repStockMovements.tenantId, ctx.tenantId), eq(repStockMovements.operationId, lineOperationIds[0]!)) });
    if (replayed) {
      if (replayed.assignmentId !== input.repStockAssignmentId) throw new AppError("VALIDATION_FAILED", "This Idempotency-Key was already used for a different operation");
      const movements = await tx.select().from(repStockMovements).where(and(eq(repStockMovements.tenantId, ctx.tenantId), inArray(repStockMovements.operationId, lineOperationIds)));
      return { assignmentId: replayed.assignmentId, movements, replayed: true };
    }

    const [assignment] = await tx.select().from(repStockAssignments).where(and(eq(repStockAssignments.id, input.repStockAssignmentId), eq(repStockAssignments.tenantId, ctx.tenantId))).for("update");
    if (!assignment) throw new AppError("RESOURCE_NOT_FOUND", "Rep stock assignment not found");
    if (assignment.status !== "ISSUED") throw new AppError("VALIDATION_FAILED", `Assignment is ${assignment.status}; custody write-off is only allowed on an ISSUED assignment`);

    let costTotalUnits = 0n;
    const movements: Array<typeof repStockMovements.$inferSelect> = [];
    for (const [index, line] of input.lines.entries()) {
      const item = await tx.query.items.findFirst({ where: and(eq(items.id, line.itemId), eq(items.tenantId, ctx.tenantId)) });
      if (!item) throw new AppError("RESOURCE_NOT_FOUND", "Item not found");
      if ((item.batchTracked || item.expiryTracked) && !line.batchId) throw new AppError("VALIDATION_FAILED", `${item.name} requires a batch`);
      if (!item.batchTracked && line.batchId) throw new AppError("VALIDATION_FAILED", `${item.name} does not accept a batch`);

      const batchCondition = line.batchId ? eq(repCustodyBalances.batchId, line.batchId) : isNull(repCustodyBalances.batchId);
      const keyCondition = and(eq(repCustodyBalances.tenantId, ctx.tenantId), eq(repCustodyBalances.repMembershipId, assignment.repMembershipId), eq(repCustodyBalances.itemId, item.id), batchCondition);
      const [custody] = await tx.select().from(repCustodyBalances).where(keyCondition).for("update");
      const requestedUnits = decimalToUnits(line.quantity);
      const heldUnits = decimalToUnits(custody?.quantityOnHand ?? "0");
      if (requestedUnits > heldUnits) {
        throw new AppError("INSUFFICIENT_STOCK", `Cannot write off more ${item.name} than the rep currently holds`, { itemId: item.id, batchId: line.batchId ?? null, inCustody: unitsToDecimal(heldUnits), requested: line.quantity });
      }

      const unitCostUnits = await custodyUnitCostUnits(tx, ctx, assignment.id, item.id, line.batchId);
      costTotalUnits += (unitCostUnits * requestedUnits) / moneyScale;

      await tx.update(repCustodyBalances).set({ quantityOnHand: unitsToDecimal(heldUnits - requestedUnits), updatedAt: new Date() }).where(keyCondition);
      const [movement] = await tx
        .insert(repStockMovements)
        .values({ tenantId: ctx.tenantId, assignmentId: assignment.id, itemId: item.id, batchId: line.batchId, movementType: line.reason === "DAMAGED" ? "RETURN_DAMAGED" : "RETURN_EXPIRED", quantity: `-${line.quantity}`, referenceType: "CUSTODY", referenceId: assignment.id, operationId: lineOperationIds[index]! })
        .returning();
      if (!movement) throw new AppError("INTERNAL_ERROR", "Unable to record custody write-off movement");
      movements.push(movement);
    }

    await postCustodyWriteOffJournal(tx, ctx, { assignmentId: assignment.id, operationId, costTotal: unitsToDecimal(costTotalUnits) });

    await recordAudit(tx, ctx, {
      action: "rep_stock.custody_writeoff",
      entityType: "REP_STOCK_ASSIGNMENT",
      entityId: assignment.id,
      after: { repMembershipId: assignment.repMembershipId, lines: input.lines, costTotal: unitsToDecimal(costTotalUnits) },
    });

    return { assignmentId: assignment.id, movements, replayed: false };
  });
}
