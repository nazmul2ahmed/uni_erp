import { z } from "zod";
import { idSchema, shortTextSchema, nonNegativeMoneyStringSchema, nonNegativeQuantityStringSchema } from "./shared";

/**
 * Item (Catalog) domain schemas.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §6.1-6.2 (Item entity,
 * invariants, ItemTrackingPolicy) and 11_API_SPECIFICATION.md §7.
 *
 * NOT included here: `allowNegativeStock`. Per 09 §4.7 (Decision
 * INV-007) and the seeded permission catalog, toggling this requires
 * the elevated `inventory.allow_negative_stock` permission (OWNER-only
 * by current seed). Keeping it OFF this general create/update schema
 * means the API route layer can gate it as a SEPARATE, explicitly
 * permission-checked action rather than a bare field any
 * `catalog.create`/`catalog.update` holder could flip incidentally —
 * consistent with 11 §20's per-endpoint permission-bracket model.
 *
 * Cross-field invariants (07 §6.1):
 *   "expiry_tracked = true requires batch_tracked = true"
 *   "serial_tracked = true implies stock_tracked = true"
 * are enforced via `.refine()` on CREATE only (§ below explains why
 * not on UPDATE).
 */

export const itemTypeSchema = z.enum([
  "PRODUCT",
  "SERVICE",
  "RAW_MATERIAL",
  "CONSUMABLE",
  "RENTAL_ASSET",
  "NON_STOCK",
]);

const itemBaseObjectSchema = z.object({
  sku: z.string().trim().min(1).max(100).optional(),
  name: shortTextSchema(200),
  type: itemTypeSchema,
  categoryId: idSchema.optional(),
  brandId: idSchema.optional(),
  unitId: idSchema,
  purchasePrice: nonNegativeMoneyStringSchema.default("0"),
  sellingPrice: nonNegativeMoneyStringSchema.default("0"),
  lowStockThreshold: nonNegativeQuantityStringSchema.optional(), // null/absent = never fires StockLow (23 §14.1)
  stockTracked: z.boolean().default(true),
  batchTracked: z.boolean().default(false),
  expiryTracked: z.boolean().default(false),
  serialTracked: z.boolean().default(false),
  rentalTracked: z.boolean().default(false),
  warrantyTracked: z.boolean().default(false),
});

export const createItemSchema = itemBaseObjectSchema
  .refine((v) => !v.expiryTracked || v.batchTracked, {
    message: "expiryTracked requires batchTracked (07 §6.1 invariant)",
    path: ["expiryTracked"],
  })
  .refine((v) => !v.serialTracked || v.stockTracked, {
    message: "serialTracked implies stockTracked (07 §6.1 invariant)",
    path: ["serialTracked"],
  });
export type CreateItemInput = z.infer<typeof createItemSchema>;

/**
 * Partial patch — deliberately WITHOUT the two `.refine()` checks
 * above. Zod's `.partial()` cannot be chained after `.refine()`
 * (refine returns a ZodEffects wrapper, not a ZodObject), and more
 * importantly a partial PATCH cannot validate the cross-field
 * invariant in isolation anyway — an update that only sends
 * `{ expiryTracked: true }` is only valid or invalid depending on
 * the item's CURRENT persisted `batchTracked` value, which this
 * schema has no visibility into. The domain layer (UpdateItem use
 * case, 07 §6.3) re-validates the invariant against the MERGED
 * (current + patch) state before persisting — this is the same
 * "client validation for UX, server validation authoritative"
 * split documented in 04 §12.
 */
export const updateItemSchema = itemBaseObjectSchema.partial();
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

/** GET /api/items?q= — per 11 §7. */
export const searchItemsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});
export type SearchItemsQuery = z.infer<typeof searchItemsQuerySchema>;

/* -------------------------------------------------------------- */
/* Catalog primitives — ItemCategory / Brand / Unit, per 11 §7       */
/* -------------------------------------------------------------- */

export const createItemCategorySchema = z.object({
  name: shortTextSchema(200),
  parentId: idSchema.optional(),
});
export type CreateItemCategoryInput = z.infer<typeof createItemCategorySchema>;

export const createBrandSchema = z.object({
  name: shortTextSchema(200),
});
export type CreateBrandInput = z.infer<typeof createBrandSchema>;

export const createUnitSchema = z.object({
  name: shortTextSchema(100),
  symbol: z.string().trim().min(1).max(20),
  isDecimal: z.boolean().default(false),
});
export type CreateUnitInput = z.infer<typeof createUnitSchema>;