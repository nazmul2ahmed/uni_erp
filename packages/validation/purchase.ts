import { z } from "zod";
import { idSchema, optionalShortTextSchema, nonNegativeMoneyStringSchema, positiveQuantityStringSchema } from "./shared";

/**
 * Purchase domain schemas.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §8.1-8.3 (Purchase/PurchaseLine
 * entities, ReceivePurchaseUseCase) and 06_DATABASE_SPECIFICATION.md
 * v2.0 §5.9. 07 §8 states Purchase "Structurally parallels Sales
 * (§18, `03`)" — this schema deliberately mirrors sale.ts's shape and
 * exclusions for that reason.
 *
 * NOT included here (same reasoning as sale.ts):
 *
 *   lineTotal / subtotal / taxTotal / grandTotal / paidTotal / dueTotal
 *     — derived server-side, never client input (same rationale as
 *     sale.ts).
 *
 *   purchaseNumber / localNumber — server-generated (04 §95, 06 v2.0
 *     §5.9), never client-assigned.
 *
 *   status — server-computed lifecycle, not client-set on create.
 *
 *   operationId — Idempotency-Key header (11 §2.2), REQUIRED on this
 *     endpoint (Decision API-001), not a body field.
 *
 *   deviceId — offline sync envelope only (10 §2.1), deferred to
 *     Phase 4 per 28 §4, same as sale.ts.
 *
 * NOT expressible in Zod, deferred to the domain layer (04 §12):
 *   - stock/batch creation side effects (07 §8.3 step 5)
 *   - AI-OCR confirmation path uses a SEPARATE schema entirely
 *     (ConfirmPurchaseFromOCRUseCase, 07 §8.4) — not this one; no
 *     code path may feed `extracted_data` into this schema's shape
 *     directly, per Decision DOM-005 / API-002.
 *
 * ASSUMPTION FLAGGED (not settled by any spec document verbatim):
 * neither `06` v2.0 §5.9 nor `11` §9 give an explicit illustrative
 * JSON body for POST /api/purchases the way `11` §8 does for Sales.
 * `orderDiscount` (header-level discount) and `cashPaid` (amount paid
 * at receipt, feeding `paidTotal`/`dueTotal`, per 07 §8.3 step 8) are
 * named here by direct structural analogy to sale.ts's
 * `orderDiscount`/`cashReceived`, consistent with 07 §8's own
 * "structurally parallels Sales" statement. This is a naming-only
 * assumption — it does not affect any architectural, security, or
 * accounting invariant — but is called out explicitly per the
 * Documentation-First Rule rather than silently invented.
 */

export const purchaseLineSchema = z.object({
  itemId: idSchema,
  description: optionalShortTextSchema(500),
  quantity: positiveQuantityStringSchema, // per DB CHECK purchase_items_quantity_positive
  costPrice: nonNegativeMoneyStringSchema,
  sellingPrice: nonNegativeMoneyStringSchema.optional(), // optional per-purchase price update, 06 v2.0 §5.9
  lineDiscount: nonNegativeMoneyStringSchema.default("0"),
  // Input capture only — NO FK to core.stock_batches at this layer.
  // The canonical StockBatch row is created separately by
  // ReceivePurchaseUseCase (07 §8.3 step 5), per commerce.ts's own
  // design note (avoids duplicating pharmacy vocabulary in Core,
  // 01 §55). Progressive disclosure at the UI layer (12 §6.3) shows
  // these fields only when the selected item's tracking flags require
  // them — this schema itself does not enforce that conditionality
  // (external Item state, same class of deferral as sale.ts's
  // batchId/serialId).
  batchNumber: optionalShortTextSchema(100),
  expiryDate: z.string().date().optional(),
  warehouseId: idSchema,
});
export type PurchaseLineInput = z.infer<typeof purchaseLineSchema>;

export const createPurchaseSchema = z.object({
  supplierId: idSchema,
  branchId: idSchema,
  lines: z.array(purchaseLineSchema).min(1, "A purchase must contain at least one line"), // same assumption class as sale.ts
  orderDiscount: nonNegativeMoneyStringSchema.default("0"), // [ASSUMPTION, see docblock]
  cashPaid: nonNegativeMoneyStringSchema.default("0"), // [ASSUMPTION, see docblock] — feeds paidTotal/dueTotal, 07 §8.3 step 8
  purchaseDate: z.string().datetime({ offset: true }).optional(),
});
export type CreatePurchaseInput = z.infer<typeof createPurchaseSchema>;

/** GET /api/purchases?... — per 11 §9, common filters (04 §155). */
export const searchPurchasesQuerySchema = z.object({
  supplierId: idSchema.optional(),
  branchId: idSchema.optional(),
  status: z
    .enum(["DRAFT", "CONFIRMED", "RECEIVED", "PAID", "PARTIALLY_PAID", "CANCELLED"])
    .optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
});
export type SearchPurchasesQuery = z.infer<typeof searchPurchasesQuerySchema>;
