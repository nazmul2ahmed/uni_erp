import { z } from "zod";

/**
 * Password policy per 13_SECURITY_SPECIFICATION.md §2.2:
 * length >= 10, no composition-rule theater.
 */
export const passwordSchema = z.string().min(10, "Password must be at least 10 characters");

// Order fix (Phase 2 discovery, runtime-verified): trim/lowercase
// BEFORE the .email() format check, not after — the original
// .email().transform(trim+lowercase) rejected otherwise-valid input
// with surrounding whitespace (e.g. "  Foo@Bar.com  ") because the
// format check ran on the untrimmed string. Trimming/lowercasing
// first, then validating, means normalization actually helps the
// check pass rather than only cosmetically cleaning up the value
// after acceptance. No change to normalized OUTPUT shape (still
// trimmed, lowercased) or to valid-input acceptance — only rejected
// whitespace-padded input now correctly passes, per 13 §4.4.
export const emailSchema = z.string().trim().toLowerCase().email();

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(1).max(200),
  businessName: z.string().trim().min(1).max(200), // becomes core.business_profiles.name
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const tenantSelectSchema = z.object({
  tenantId: z.string().uuid(),
});
export type TenantSelectInput = z.infer<typeof tenantSelectSchema>;
