/**
 * Staff/Membership application-layer use cases.
 * Per 05_MULTI_TENANT_ARCHITECTURE.md §75a-78 and
 * 11_API_SPECIFICATION.md §15.
 *
 * These use cases operate ENTIRELY on control.* tables (users,
 * memberships, roles, tenants) — Control Plane, per 05 §11. Unlike
 * every core.* use case elsewhere in this codebase, they do NOT use
 * withTenantTransaction() (that helper's SET LOCAL app.tenant_id call
 * exists to satisfy core.*'s RLS policies; control.* tables carry NO
 * RLS — 05 §11-13, confirmed by apps/web/test/tenant-isolation.
 * integration.test.ts's own comments). withPlatformTransaction()
 * (packages/db/client.ts) is used instead, with EXPLICIT tenantId
 * filtering on every query — the same defense-in-depth discipline RLS
 * gives core.* tables is provided here purely at the application
 * layer, since it is the only layer available for control.* tables.
 *
 * NOT implemented in this pass (explicitly deferred, not silently
 * skipped):
 *   - A distinct "invitee accepts invite" flow / status=INVITED
 *     lifecycle — no email delivery integration exists yet
 *     (Automation/Notification is Phase 8, per 28 §4). inviteStaff()
 *     creates memberships directly at ACTIVE, returning a one-time
 *     temporary password for out-of-band relay when a brand-new user
 *     is created. This is a flagged Phase-1 simplification, not a
 *     ratified long-term design.
 *   - Reauthentication/step-up-auth before transferOwnership() (05
 *     §76 suggests it "may be required") — no such mechanism exists
 *     anywhere in this codebase yet (13 §14 Q2, open platform-wide).
 *     A `confirm: true` field (packages/validation/staff.ts) is a
 *     minimal placeholder gate, not a substitute.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { memberships, roles, tenants, users, withPlatformTransaction } from "@erp/db";
import type { Database } from "@erp/db";
import { AppError } from "@erp/shared";
import type { InviteStaffInput, UpdateMembershipInput } from "@erp/validation";
import type { TenantContext } from "../guard";
import { hashPassword } from "../password";
import { recordPlatformAudit } from "../platform-audit";
import { isActiveOperator } from "../platform-operator";

const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

/** A role is usable by this tenant if it's a platform preset (tenantId
 * null) or this tenant's own custom role — never another tenant's
 * custom role (IDOR-safe, mirrors 05 §92 applied to a foreign-key
 * reference rather than a direct resource load). */
async function assertRoleUsableByTenant(tx: Database, tenantId: string, roleId: string) {
  const role = await tx.query.roles.findFirst({
    where: and(eq(roles.id, roleId), or(isNull(roles.tenantId), eq(roles.tenantId, tenantId))),
  });
  if (!role) throw new AppError("RESOURCE_NOT_FOUND", "Role not found");
  return role;
}

export async function listStaff(ctx: TenantContext) {
  return withPlatformTransaction(async (tx) => {
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
    const rows = await tx
      .select({
        membershipId: memberships.id,
        status: memberships.status,
        joinedAt: memberships.createdAt,
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(eq(memberships.tenantId, ctx.tenantId));

    return rows.map((row) => ({ ...row, isOwner: row.membershipId === tenant?.ownerMembershipId }));
  });
}

/**
 * POST /api/staff/invite — per 11 §15 [staff.manage].
 *
 * Per 05 §12 ("একজন user ভবিষ্যতে একাধিক tenant-এর member হতে পারবে"):
 * `control.users.email` is globally unique (schema/control.ts). If the
 * email already corresponds to an existing platform user, this ADDS a
 * membership for the existing user rather than erroring — that is the
 * expected, spec-sanctioned multi-tenant-membership path, not an edge
 * case to reject.
 */
export async function inviteStaff(ctx: TenantContext, input: InviteStaffInput) {
  return withPlatformTransaction(async (tx) => {
    await assertRoleUsableByTenant(tx, ctx.tenantId, input.roleId);

    let userId: string;
    let temporaryPassword: string | undefined;

    const existingUser = await tx.query.users.findFirst({ where: eq(users.email, input.email) });
    if (existingUser) {
      // ADR-001 rule 3: a platform-operator account may never join a workspace. The message is
      // deliberately generic -- a tenant owner must not be able to learn which emails are operators.
      if (await isActiveOperator(existingUser.id, tx)) {
        throw new AppError("VALIDATION_FAILED", "This email cannot be added to a workspace", { field: "email" });
      }
      userId = existingUser.id;
    } else {
      // Random, high-entropy, argon2id-hashed — never derived from
      // anything guessable (email/name/timestamp), per 13 §2.2.
      // Returned ONCE in the API response for out-of-band relay (see
      // this file's docblock) — never logged, never re-derivable
      // after this call returns.
      temporaryPassword = randomBytes(18).toString("base64url");
      const [created] = await tx
        .insert(users)
        .values({ email: input.email, passwordHash: await hashPassword(temporaryPassword), fullName: input.fullName, mustChangePassword: true })
        .returning();
      userId = created!.id;
    }

    try {
      const [membership] = await tx
        .insert(memberships)
        .values({ userId, tenantId: ctx.tenantId, roleId: input.roleId, status: "ACTIVE" })
        .returning();

      await recordPlatformAudit(tx, ctx, {
        action: "membership.invited",
        after: { membershipId: membership!.id, userId, roleId: input.roleId, newUser: !existingUser },
      });

      return { membership: membership!, temporaryPassword };
    } catch (e) {
      if (isUniqueViolation(e)) {
        // memberships_user_tenant_unique — this person already has a
        // membership (of any status) for this tenant.
        throw new AppError("DUPLICATE_RESOURCE", "This person is already a member of this tenant");
      }
      throw e;
    }
  });
}

/**
 * PATCH /api/staff/members/:membershipId — per 11 §15 [staff.manage].
 * Enforces INV-OWN-002 (05 §75a): the canonical owner's membership can
 * only be modified via transferOwnership() below, never a direct
 * role/status PATCH — checked BEFORE applying any field change,
 * regardless of whether the requested change would have been a no-op.
 */
export async function updateMembership(ctx: TenantContext, membershipId: string, input: UpdateMembershipInput) {
  return withPlatformTransaction(async (tx) => {
    const membership = await tx.query.memberships.findFirst({
      where: and(eq(memberships.id, membershipId), eq(memberships.tenantId, ctx.tenantId)),
    });
    if (!membership) throw new AppError("MEMBERSHIP_NOT_FOUND", "Membership not found");

    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
    if (membership.id === tenant?.ownerMembershipId) {
      // INV-OWN-002 — the literal spec algorithm (05 §75a) rejects
      // unconditionally here; it does not special-case "the new value
      // equals the current value."
      throw new AppError("OWNER_TRANSFER_REQUIRED", "The tenant owner's membership cannot be modified directly — transfer ownership first");
    }

    if (input.roleId) await assertRoleUsableByTenant(tx, ctx.tenantId, input.roleId);

    const before = { roleId: membership.roleId, status: membership.status };
    const [updated] = await tx
      .update(memberships)
      .set({ ...(input.roleId ? { roleId: input.roleId } : {}), ...(input.status ? { status: input.status } : {}), updatedAt: new Date() })
      .where(eq(memberships.id, membershipId))
      .returning();

    await recordPlatformAudit(tx, ctx, {
      action: "membership.updated",
      before,
      after: { roleId: updated!.roleId, status: updated!.status },
    });

    return updated!;
  });
}

/**
 * Ownership transfer — per 05 §76, Decision (this pass): restricted to
 * the CURRENT canonical owner initiating their own transfer (mirrors
 * 26 §11's Owner-only precedent for similarly "narrowest role"
 * commercial/authority-boundary actions) — `staff.manage` alone is
 * NOT sufficient, since this is a strictly more sensitive action than
 * ordinary staff management.
 */
export async function transferOwnership(ctx: TenantContext, newOwnerMembershipId: string) {
  return withPlatformTransaction(async (tx) => {
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, ctx.tenantId) });
    if (!tenant) throw new AppError("TENANT_ACCESS_DENIED", "Tenant not found");
    if (tenant.ownerMembershipId !== ctx.membershipId) {
      throw new AppError("PERMISSION_DENIED", "Only the current tenant owner may transfer ownership");
    }

    const newOwner = await tx.query.memberships.findFirst({
      where: and(eq(memberships.id, newOwnerMembershipId), eq(memberships.tenantId, ctx.tenantId)),
    });
    if (!newOwner) throw new AppError("MEMBERSHIP_NOT_FOUND", "Target membership not found");
    if (newOwner.status !== "ACTIVE") {
      // INV-OWN-003 step (a).
      throw new AppError("VALIDATION_FAILED", "The new owner's membership must be ACTIVE");
    }
    if (newOwner.id === tenant.ownerMembershipId) {
      throw new AppError("VALIDATION_FAILED", "This membership is already the tenant owner");
    }

    // INV-OWN-003 step (b) — single atomic UPDATE; owner_membership_id
    // is never observably null (it moves from one non-null value
    // directly to another, within one transaction/statement).
    const [updatedTenant] = await tx
      .update(tenants)
      .set({ ownerMembershipId: newOwner.id, updatedAt: new Date() })
      .where(eq(tenants.id, ctx.tenantId))
      .returning();

    // INV-OWN-003 step (c) is explicitly OPTIONAL per 05 §75a ("tenant
    // policy") — this implementation does NOT auto-change the
    // previous owner's role, per the "no silent, unrequested mutation"
    // discipline (29 §6.1's spirit applied to a business decision
    // rather than code duplication). The prior owner keeps whatever
    // role they held; only the canonical `owner_membership_id` pointer
    // moves.
    await recordPlatformAudit(tx, ctx, {
      action: "ownership.transferred",
      before: { ownerMembershipId: ctx.membershipId },
      after: { ownerMembershipId: newOwner.id },
    });

    return updatedTenant!;
  });
}
