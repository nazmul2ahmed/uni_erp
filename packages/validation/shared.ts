import { z } from "zod";

/**
 * Cross-domain shared primitives.
 * Per 07_CORE_DOMAIN_SPECIFICATION.md §2 ("Shared Value Objects...
 * Money, Quantity, DateRange, Result, ID") and
 * 04_PLATFORM_ARCHITECTURE.md §62-64 (Money/Quantity Representation,
 * Decimal Safety).
 *
 * These validate SHAPE only (a well-formed decimal string, per
 * 06 v2.0 §2's `numeric(18,4)` convention) — they do NOT perform
 * decimal-safe arithmetic. Actual calculation (subtotal/tax/totals)
 * happens in the domain layer using a decimal-safe library, per
 * 13_SECURITY_SPECIFICATION.md §4.4: "Money/Quantity: parsed via
 * decimal-safe library — never parseFloat() on a user-supplied
 * string used in a financial calculation." Which library is an open
 * decision deferred to the domain-layer implementation step (not
 * needed for schema-level format validation).
 *
 * Numbers arrive over the wire as STRINGS (per 11 §8's illustrative
 * body: "quantity": "2.00", "unitPrice": "150.00") — never `number`,
 * to avoid JSON floating-point precision loss before the string even
 * reaches decimal-safe parsing.
 *
 * NOTE: email normalization already exists as `emailSchema` in
 * ./auth.ts (register/login flow) — NOT redefined here. Domain
 * schemas that need an optional email field import from ./auth and
 * apply `.optional()` at the call site, per the "no duplicate
 * validation logic" discipline (29 §6.1).
 */

/** Non-negative decimal string, up to 4 decimal places (numeric(18,4)). */
export const nonNegativeMoneyStringSchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "Must be a non-negative amount with at most 4 decimal places");

/** Non-negative decimal quantity string, up to 4 decimal places. */
export const nonNegativeQuantityStringSchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "Must be a non-negative quantity with at most 4 decimal places");

/**
 * Strictly positive decimal money string. Mirrors the DB-level
 * defense-in-depth CHECK constraints added in
 * migrations-manual/0005_rls_policies_commerce.sql (e.g.
 * `payments_amount_positive: CHECK (amount > 0)`) — validating this
 * shape at the schema layer lets an obviously-invalid request
 * (amount = "0" or "0.00") fail fast with a client-facing 400
 * instead of reaching the database constraint. The DB CHECK remains
 * authoritative (04 §12); this is the UX-layer mirror only.
 */
export const positiveMoneyStringSchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "Must be a positive amount with at most 4 decimal places")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

/**
 * Strictly positive decimal quantity string. Mirrors
 * `sale_items_quantity_positive` / `purchase_items_quantity_positive`
 * (07 §7.3 invariant 6; 0005_rls_policies_commerce.sql) — same
 * fail-fast rationale as `positiveMoneyStringSchema` above.
 */
export const positiveQuantityStringSchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "Must be a positive quantity with at most 4 decimal places")
  .refine((v) => Number(v) > 0, "Quantity must be greater than zero");

/** UUID primary/foreign key reference. */
export const idSchema = z.string().uuid();

/**
 * Free-text field caps, per 13 §4.4 ("trim whitespace, cap max
 * length... strip control characters"). Control-character stripping
 * itself is NOT done here (Zod has no built-in strip transform for
 * this) — it is a server-layer concern applied after schema
 * validation passes, not duplicated here.
 */
export const shortTextSchema = (maxLen: number) => z.string().trim().min(1).max(maxLen);
export const optionalShortTextSchema = (maxLen: number) => z.string().trim().max(maxLen).optional();

/** Normalized phone — per 13 §4.4 "normalize to a consistent format
 * before uniqueness check." This schema validates SHAPE only; actual
 * normalization (e.g. stripping formatting characters to a canonical
 * form) is a server-layer concern, not duplicated here. */
export const phoneSchema = z.string().trim().min(1).max(30).optional();