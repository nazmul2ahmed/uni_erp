import { z } from "zod";
import { emailSchema as baseEmailSchema } from "./auth";
import { shortTextSchema, optionalShortTextSchema, phoneSchema } from "./shared";

/**
 * Customer domain schemas.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §4.1 (Customer entity +
 * invariants) and 11_API_SPECIFICATION.md §5 (endpoint shapes).
 *
 * NOT included here: `openingReceivable`. Per 06_DATABASE_SPECIFICATION.md
 * v2.0 §5.4, this field is "onboarding only" — it is set exclusively
 * via the Opening Entries flow (08 §5.8, POST
 * /api/accounting/opening-entries), never as a general Customer
 * create/update field. Exposing it here would let a general-purpose
 * Customer-create call silently inject a receivable balance outside
 * that dedicated, auditable, idempotent onboarding path — a direct
 * violation of One Source of Truth (02 §49): receivable balance must
 * always derive from core.receivables + payment allocations, never
 * from a field set on Customer directly.
 *
 * Server-side authoritative validation still applies beyond this
 * schema (04 §12) — e.g. "phone unique per tenant unless isWalkIn"
 * (07 §4.1 invariant) is a database/domain-layer check, not
 * expressible in Zod alone.
 */

export const customerTypeSchema = z.enum(["INDIVIDUAL", "ORGANIZATION"]);

export const createCustomerSchema = z.object({
  type: customerTypeSchema.default("INDIVIDUAL"),
  name: shortTextSchema(200), // per 13 §4.4 name cap
  phone: phoneSchema,
  email: baseEmailSchema.optional(), // reuses auth.ts's normalization (29 §6.1)
  address: optionalShortTextSchema(500), // per 13 §4.4 free-text cap
  isWalkIn: z.boolean().default(false),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

/**
 * Partial patch — no cross-field invariant re-check here (there are
 * none for Customer beyond the phone-uniqueness rule, which is a
 * server-layer/DB constraint regardless of which fields are patched).
 */
export const updateCustomerSchema = createCustomerSchema.partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

/** GET /api/customers?q= — per 11 §5 free-text search param. */
export const searchCustomersQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});
export type SearchCustomersQuery = z.infer<typeof searchCustomersQuerySchema>;