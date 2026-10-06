import { z } from "zod";
import { idSchema, positiveQuantityStringSchema } from "./shared";

/**
 * Van/Route Sales — `IssueRepStockUseCase` input.
 * Per `30_MODULE_VAN_SALES.md` §4.2:
 *   "Input: repMembershipId, warehouseId, branchId, lines[] (itemId,
 *    batchId?, quantity), operationId"
 *
 * NOT included here (deliberate, mirrors sale.ts's own "NOT included"
 * docblock discipline):
 *
 *   operationId — arrives via the `Idempotency-Key` HTTP header
 *     (11 §2.2), not a JSON body field, consistent with every other
 *     financial-mutation endpoint in this codebase (CreateSaleInput,
 *     CreatePurchaseInput).
 *
 *   AllocationStrategy auto-selection — §4.2 step 5 references
 *     "AllocationStrategy.selectStockFor(...) per line (09 §4 —
 *     REUSED, not reimplemented)". As found during this session's
 *     implementation trace: NO such auto-selecting abstraction exists
 *     anywhere in this codebase yet — completeSale()/receivePurchase()
 *     both operate in 09 §4.5's MANUAL mode exclusively (the caller
 *     supplies `batchId` directly; the use case only VALIDATES that
 *     specific batch, never auto-picks via FEFO/FIFO). §4.2's own
 *     Input shape is consistent with this — `batchId` is listed as a
 *     caller-supplied field, not something the use case derives. This
 *     schema and its use case therefore follow the SAME Manual-mode
 *     precedent as every other stock-affecting use case in this
 *     codebase, rather than introducing a first-of-its-kind FEFO/FIFO
 *     auto-allocation engine unprompted — flagged here, not silently
 *     decided, per the project's "surface findings before implementing"
 *     discipline.
 *
 * serialId is deliberately OMITTED at MVP for this use case: 30 §3's
 * `RepStockAssignmentLine` shape itself has no serialId field (only
 * itemId/batchId/quantity) — issuing serial-tracked items to a field
 * rep is out of this spec's stated scope, not an oversight.
 */
export const issueRepStockLineSchema = z.object({
  itemId: idSchema,
  batchId: idSchema.optional(),
  quantity: positiveQuantityStringSchema,
});
export type IssueRepStockLineInput = z.infer<typeof issueRepStockLineSchema>;

export const issueRepStockSchema = z.object({
  repMembershipId: idSchema,
  warehouseId: idSchema,
  branchId: idSchema,
  lines: z
    .array(issueRepStockLineSchema)
    // Same "not explicitly stated as a numeric invariant, but a sensible
    // domain-level assumption" flag as sale.ts's identical .min(1) note —
    // an assignment issuing zero lines has nothing to reconcile.
    .min(1, "An assignment must contain at least one line"),
  expectedReturnAt: z.string().datetime({ offset: true }).optional(),
});
export type IssueRepStockInput = z.infer<typeof issueRepStockSchema>;

/**
 * Van/Route Sales -- `RecordCustodyWriteOffUseCase` input (Flow 1, 30 §5.1).
 *   "Input: repStockAssignmentId, lines[] (itemId, batchId?, quantity,
 *    reason: DAMAGED | EXPIRED), operationId"
 * operationId arrives via the Idempotency-Key header (11 §2.2), as for every other mutation.
 * repStockAssignmentId is the resource id (URL path in Phase 5); it is validated here so the use
 * case has one typed input object.
 */
export const custodyWriteOffLineSchema = z.object({
  itemId: idSchema,
  batchId: idSchema.optional(),
  quantity: positiveQuantityStringSchema,
  reason: z.enum(["DAMAGED", "EXPIRED"]),
});
export type CustodyWriteOffLineInput = z.infer<typeof custodyWriteOffLineSchema>;

export const recordCustodyWriteOffSchema = z.object({
  repStockAssignmentId: idSchema,
  lines: z.array(custodyWriteOffLineSchema).min(1, "A write-off must contain at least one line"),
});
export type RecordCustodyWriteOffInput = z.infer<typeof recordCustodyWriteOffSchema>;
