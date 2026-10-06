import { z } from "zod";
import { emailSchema as baseEmailSchema } from "./auth";
import { shortTextSchema, optionalShortTextSchema, phoneSchema } from "./shared";

/**
 * Supplier domain schemas.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §5 (structurally mirrors
 * Customer, per 02 §8) and 11_API_SPECIFICATION.md §6.
 *
 * NOT included here: `openingPayable` — same "onboarding only"
 * exclusion reasoning as customer.ts's `openingReceivable`, per
 * 06 v2.0 §5.5.
 */

export const createSupplierSchema = z.object({
  name: shortTextSchema(200),
  phone: phoneSchema,
  email: baseEmailSchema.optional(), // reuses auth.ts's normalization (29 §6.1)
  address: optionalShortTextSchema(500),
  contactPerson: optionalShortTextSchema(200),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = createSupplierSchema.partial();
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

/** GET /api/suppliers?q= — per 11 §6. */
export const searchSuppliersQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});
export type SearchSuppliersQuery = z.infer<typeof searchSuppliersQuerySchema>;