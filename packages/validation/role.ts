import { z } from "zod";
import { shortTextSchema } from "./shared";

/**
 * Role domain schemas (tenant-custom roles).
 * Per 06_DATABASE_SPECIFICATION.md §4.4 and 11_API_SPECIFICATION.md §15.
 *
 * Preset/system roles (`isSystemRole = true`, `tenantId = null`, seeded
 * by packages/db/seed/seed-control-plane.ts — OWNER/MANAGER/STAFF) are
 * READ-ONLY via this API — createRole/updateRole always scope to
 * `tenantId = ctx.tenantId`, so a preset role is structurally
 * unreachable through these use cases (per 05 §92's IDOR-safe
 * tenant-scoped-query pattern, not a separate isSystemRole check).
 */

/** Machine-readable role key — same UPPER_SNAKE_CASE convention as the
 * platform presets (OWNER/MANAGER/STAFF), for consistency rather than
 * inventing a second key format for tenant-custom roles. */
export const roleKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,49}$/, "Role key must be UPPER_SNAKE_CASE, 2-50 characters, starting with a letter");

export const createRoleSchema = z.object({
  key: roleKeySchema,
  name: shortTextSchema(100),
  permissionKeys: z.array(z.string().min(1)).min(1, "At least one permission is required"),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    name: shortTextSchema(100).optional(),
    permissionKeys: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((v) => v.name !== undefined || v.permissionKeys !== undefined, {
    message: "At least one of name or permissionKeys must be provided",
  });
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
