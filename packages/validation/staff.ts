import { z } from "zod";
import { emailSchema } from "./auth";
import { idSchema, shortTextSchema } from "./shared";

/**
 * Staff/Membership domain schemas.
 * Per 05_MULTI_TENANT_ARCHITECTURE.md §75a/§76-78 and
 * 11_API_SPECIFICATION.md §15 (Tenant/Staff/RBAC Endpoints).
 */

export const inviteStaffSchema = z.object({
  email: emailSchema,
  fullName: shortTextSchema(200),
  roleId: idSchema,
});
export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;

/**
 * `INVITED` is intentionally excluded from the settable set here.
 * Per 06 §4.3, a membership CAN hold status=INVITED, but this
 * Phase-1 implementation has no separate "invitee accepts" step yet
 * (no email delivery integration — Automation/Notification is Phase
 * 8, per 28 §4) — inviteStaff() creates memberships directly at
 * ACTIVE. Reintroducing INVITED as a settable target via this PATCH
 * would create a state no other code path can ever transition out of.
 */
export const membershipStatusSchema = z.enum(["ACTIVE", "SUSPENDED", "REMOVED"]);

export const updateMembershipSchema = z
  .object({
    roleId: idSchema.optional(),
    status: membershipStatusSchema.optional(),
  })
  .refine((v) => v.roleId !== undefined || v.status !== undefined, {
    message: "At least one of roleId or status must be provided",
  });
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;

/**
 * Per 05 §76 ("critical action... confirmation, audit, reauthentication
 * প্রয়োজন হতে পারে"). Reauthentication/step-up-auth is NOT implemented
 * here — no such mechanism exists anywhere in this codebase yet (13
 * §14 Q2 flags MFA as an open question platform-wide) — this is a
 * flagged, deferred gap, not a silent omission. `confirm: true` is a
 * minimal, explicit client-side acknowledgment gate in its place,
 * pending a real step-up-auth mechanism.
 *
 * The transfer TARGET (newOwnerMembershipId) travels in the URL path
 * (POST /api/staff/members/:membershipId/transfer-ownership), not in
 * this body — REST convention: the resource being acted upon (the
 * membership becoming owner) is the path, this schema is only the
 * confirmation gate.
 */
export const transferOwnershipSchema = z.object({
  confirm: z.literal(true, { errorMap: () => ({ message: "confirm must be true to transfer ownership" }) }),
});
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
