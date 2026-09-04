import { z } from "zod";
import {
  idSchema,
  shortTextSchema,
  optionalShortTextSchema,
  nonNegativeMoneyStringSchema,
  positiveQuantityStringSchema,
} from "./shared";

/**
 * Sale domain schemas.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §7.1-7.3 (Sale/SaleLine entities
 * + invariants), 07 §7.6 (CompleteSaleUseCase), 07 §7.8
 * (CreateSaleDraftUseCase), and 11_API_SPECIFICATION.md §8's
 * illustrative POST /api/sales body.
 *
 * NOT included here (deliberate, not an oversight):
 *
 *   lineTotal / subtotal / taxTotal / grandTotal / paidTotal / dueTotal
 *     — all DERIVED (07 §7.3 invariant 1-2: "lineTotal = ... derived,
 *     never stored independently of inputs"). SalePricingService
 *     computes these server-side (07 §7.6 step 5) from the inputs
 *     below (quantity, unitPrice, lineDiscount, orderDiscount). A
 *     client-supplied lineTotal/grandTotal would let a malicious or
 *     buggy client dictate the tenant's own revenue figure — the
 *     exact class of risk 13 §4.4 ("never parseFloat() on a
 *     user-supplied string used in a financial calculation") and the
 *     "server is authoritative" principle (03 §60) exist to prevent.
 *
 *   taxAmount (per SaleLine, 07 §7.2) — likewise NOT client input.
 *     11 §8's illustrative body itself omits it. Tax is computed
 *     server-side from the item/tenant TaxProfile (08 §8), not
 *     submitted per line — MVP scope is No-Tax/Single-Tax (03 §55),
 *     and even under Single-Tax the RATE is tenant configuration, not
 *     a per-request client value.
 *
 *   invoiceNumber / localNumber — server-generated (04 §95, 06 v2.0
 *     §5.8). A client can never assign its own invoice number.
 *
 *   status — the Sale status state machine (07 §7.3 invariant 4) is
 *     entirely server-computed (paidTotal vs grandTotal, per 07 §7.6
 *     step 12); never a client-set enum on create.
 *
 *   operationId — arrives via the `Idempotency-Key` HTTP header
 *     (11 §2.2), REQUIRED on this endpoint per Decision API-001, not
 *     as a JSON body field. Validated by route middleware, not here.
 *
 *   deviceId — populated only on the offline sync envelope (10 §2.1,
 *     §6.1), a distinct schema from this interactive-path body;
 *     deferred to the Offline/Sync API work (Phase 4, per 28 §4).
 *
 * Server-side authoritative validation beyond this schema (04 §12):
 *   - stock availability (InventoryLedgerService.checkAvailability,
 *     09 §8) — cannot be expressed in Zod, depends on live DB state.
 *   - serial/batch resolution against item.tracking flags (07 §7.3
 *     invariant 7) — likewise external-state-dependent, deferred to
 *     AllocationStrategy at the domain layer (07 §9.3), same reason
 *     item.ts defers its own cross-field checks needing external
 *     Item state.
 *   - discount ceiling (DiscountThresholdPolicy, 07 §7.5a) — requires
 *     the actor's permissions + tenant settings, not expressible here.
 */

export const saleLineSchema = z.object({
  itemId: idSchema,
  description: optionalShortTextSchema(500),
  quantity: positiveQuantityStringSchema, // per 07 §7.3 invariant 6, DB CHECK sale_items_quantity_positive
  unitPrice: nonNegativeMoneyStringSchema,
  lineDiscount: nonNegativeMoneyStringSchema.default("0"),
  // Mutually-exclusive-in-practice with each other (an item's
  // AllocationStrategy resolves to EITHER batch OR serial per its
  // tracking flags, 07 §6.2) — NOT enforced here since it depends on
  // the referenced Item's tracking configuration, external state this
  // schema cannot see. Re-validated at the domain layer (07 §9.3).
  batchId: idSchema.optional(),
  serialId: idSchema.optional(),
  warehouseId: idSchema,
});
export type SaleLineInput = z.infer<typeof saleLineSchema>;

const saleBaseObjectSchema = z.object({
  customerId: idSchema.nullable().optional(), // nullable = walk-in, per 11 §8 "uuid | null"
  branchId: idSchema,
  lines: z
    .array(saleLineSchema)
    // NOT explicitly stated in 07/11 as a numeric invariant — a
    // sensible domain-level assumption (a Sale with zero lines has
    // nothing to sum into grandTotal) rather than a documented rule.
    // Flagged per the "minor implementation detail" allowance rather
    // than a silent architectural decision.
    .min(1, "A sale must contain at least one line"),
  orderDiscount: nonNegativeMoneyStringSchema.default("0"), // maps to Sale.discountTotal server-side (07 §7.3 invariant 2)
  cashReceived: nonNegativeMoneyStringSchema.default("0"), // used to derive paidTotal/dueTotal (07 §7.6 step 12)
  saleDate: z.string().datetime({ offset: true }).optional(), // defaults to now() server-side (06 v2.0 §5.8) if absent
});

export const createSaleSchema = saleBaseObjectSchema;
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

/**
 * PATCH /api/sales/drafts/:id (11 §8) — per 07 §7.8, "Drafts bypass
 * full validation — only shape validation." A partial patch is
 * therefore the correct shape: any subset of the create fields may
 * be sent as the cart is built up incrementally (12 §5.3).
 */
export const updateSaleDraftSchema = saleBaseObjectSchema.partial();
export type UpdateSaleDraftInput = z.infer<typeof updateSaleDraftSchema>;

/** POST /api/sales/:id/cancel — per 07 §7.7. */
export const cancelSaleSchema = z.object({
  reason: shortTextSchema(500),
});
export type CancelSaleInput = z.infer<typeof cancelSaleSchema>;

/** GET /api/sales?... — per 11 §8, common filters (04 §155). */
export const searchSalesQuerySchema = z.object({
  customerId: idSchema.optional(),
  branchId: idSchema.optional(),
  status: z
    .enum(["DRAFT", "CONFIRMED", "PARTIALLY_PAID", "PAID", "DUE", "COMPLETED", "CANCELLED"])
    .optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
});
export type SearchSalesQuery = z.infer<typeof searchSalesQuerySchema>;
