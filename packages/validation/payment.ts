import { z } from "zod";
import { idSchema, optionalShortTextSchema, positiveMoneyStringSchema } from "./shared";

/**
 * Payment domain schemas.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §10.1-10.4 (Payment /
 * PaymentAllocation entities, RecordCustomerPaymentUseCase /
 * RecordSupplierPaymentUseCase) and 11_API_SPECIFICATION.md §12.
 *
 * Two separate schemas (not one generic "createPayment"), because
 * `partyType`/`direction` are IMPLIED by which endpoint is called
 * (POST /api/payments/customer vs .../supplier, per 11 §12) — letting
 * a single generic schema accept an arbitrary `partyType` would let a
 * caller hitting the customer-payment endpoint claim to be paying a
 * supplier, which the route's own use case (RecordCustomerPaymentUseCase,
 * always partyType=CUSTOMER/direction=IN, 07 §10.3) would silently
 * ignore or reject inconsistently. Fixing the type/direction at the
 * schema level per endpoint removes that ambiguity entirely, mirroring
 * item.ts's "don't expose a field that should only be set by a more
 * specific, permission-gated path" discipline.
 *
 * NOT included here:
 *
 *   partyType / direction — implied by endpoint (see above), never a
 *     client-set field on either schema.
 *
 *   operationId — Idempotency-Key header (11 §2.2), REQUIRED on this
 *     endpoint (Decision API-001), not a body field.
 *
 * Cross-field invariant enforced here (07 §10.2):
 *   "SUM(allocations.amount) <= payment.amount"
 * Unlike sale.ts/item.ts's deferred cross-field checks (which depend
 * on EXTERNAL state — another Item's tracking flags, another Sale's
 * current balance — that this schema cannot see), this invariant is
 * fully self-contained within the request body itself, so it CAN be
 * validated here. The `.refine()` below uses plain `Number()` parsing
 * as a fast, best-effort schema-level guard only — it is NOT the
 * authoritative decimal-safe check. Per 04 §12 (client validation for
 * UX, server validation authoritative) and shared.ts's own documented
 * caveat, the domain layer (RecordCustomerPaymentUseCase /
 * RecordSupplierPaymentUseCase) re-verifies this exact invariant using
 * a decimal-safe arithmetic library before persisting — this schema
 * only catches an obviously-malformed request early with a 400
 * instead of letting it reach the database.
 */

export const paymentMethodSchema = z.enum(["CASH", "BANK", "MFS", "CARD", "CHEQUE", "ONLINE", "OTHER"]);

/**
 * Explicit allocation against a specific open Sale. Per 07 §10.3:
 * "Allocate to specified Sale(s) / oldest-due-first if unspecified"
 * — `allocations` is therefore OPTIONAL on the parent schema; when
 * omitted, RecordCustomerPaymentUseCase auto-allocates oldest-due-first.
 */
export const customerPaymentAllocationSchema = z.object({
  saleId: idSchema,
  amount: positiveMoneyStringSchema,
});
export type CustomerPaymentAllocationInput = z.infer<typeof customerPaymentAllocationSchema>;

export const supplierPaymentAllocationSchema = z.object({
  purchaseId: idSchema,
  amount: positiveMoneyStringSchema,
});
export type SupplierPaymentAllocationInput = z.infer<typeof supplierPaymentAllocationSchema>;

function sumAllocations(allocations: { amount: string }[] | undefined): number {
  if (!allocations) return 0;
  return allocations.reduce((total, a) => total + Number(a.amount), 0);
}

export const recordCustomerPaymentSchema = z
  .object({
    customerId: idSchema,
    amount: positiveMoneyStringSchema, // DB CHECK payments_amount_positive
    method: paymentMethodSchema,
    referenceNo: optionalShortTextSchema(100),
    paidAt: z.string().datetime({ offset: true }).optional(),
    allocations: z.array(customerPaymentAllocationSchema).optional(),
  })
  .refine((v) => sumAllocations(v.allocations) <= Number(v.amount), {
    message: "SUM(allocations.amount) must not exceed payment.amount (07 §10.2 invariant)",
    path: ["allocations"],
  });
export type RecordCustomerPaymentInput = z.infer<typeof recordCustomerPaymentSchema>;

export const recordSupplierPaymentSchema = z
  .object({
    supplierId: idSchema,
    amount: positiveMoneyStringSchema,
    method: paymentMethodSchema,
    referenceNo: optionalShortTextSchema(100),
    paidAt: z.string().datetime({ offset: true }).optional(),
    allocations: z.array(supplierPaymentAllocationSchema).optional(),
  })
  .refine((v) => sumAllocations(v.allocations) <= Number(v.amount), {
    message: "SUM(allocations.amount) must not exceed payment.amount (07 §10.2 invariant)",
    path: ["allocations"],
  });
export type RecordSupplierPaymentInput = z.infer<typeof recordSupplierPaymentSchema>;

/** GET /api/payments?... — per 11 §12, common filters (04 §155). */
export const searchPaymentsQuerySchema = z.object({
  partyType: z.enum(["CUSTOMER", "SUPPLIER"]).optional(),
  partyId: idSchema.optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
});
export type SearchPaymentsQuery = z.infer<typeof searchPaymentsQuerySchema>;
