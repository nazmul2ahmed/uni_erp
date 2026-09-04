import { z } from "zod";

/**
 * Password policy per 13_SECURITY_SPECIFICATION.md §2.2:
 * length >= 10, no composition-rule theater.
 */
export const passwordSchema = z.string().min(10, "Password must be at least 10 characters");

export const emailSchema = z
  .string()
  .email()
  .transform((v) => v.trim().toLowerCase()); // per 13 §4.4 email normalization

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
