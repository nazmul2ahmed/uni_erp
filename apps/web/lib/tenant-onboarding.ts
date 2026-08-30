/**
 * CreateTenantAndOwnerUseCase (Phase 1 minimal implementation).
 *
 * Implements the tenant owner signup flow (11 §4) atomically:
 *   User -> Tenant -> BusinessProfile -> OWNER Membership -> tenant ACTIVE
 *
 * Satisfies INV-OWN-001 (05 §75a, Decision TEN-001): owner_membership_id
 * is only transiently null WITHIN this single uncommitted transaction —
 * never observable as null on a tenant whose status is already ACTIVE,
 * since both the membership insert and the tenant.status/ownerMembershipId
 * update happen in the same COMMIT.
 */
import { db, users, tenants, businessProfiles, memberships, roles } from "@erp/db";
import { AppError } from "@erp/shared";
import { and, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { hashPassword } from "./password";
import type { RegisterInput } from "@erp/validation";

export async function registerOwnerAndTenant(input: RegisterInput) {
  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) {
    throw new AppError("EMAIL_ALREADY_REGISTERED", "An account with this email already exists");
  }

  const passwordHash = await hashPassword(input.password);

  const ownerRole = await db.query.roles.findFirst({
    where: and(isNull(roles.tenantId), eq(roles.key, "OWNER")),
  });
  if (!ownerRole) {
    // Seed script (packages/db/seed/seed-control-plane.ts) was not run.
    throw new AppError("INTERNAL_ERROR", "Platform not seeded: OWNER role missing");
  }

  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: input.email, passwordHash, fullName: input.fullName })
      .returning();

    // status stays PROVISIONING and ownerMembershipId stays null until
    // the end of this SAME transaction — never externally observable.
    const [tenant] = await tx
      .insert(tenants)
      .values({ name: input.businessName, status: "PROVISIONING", storageMode: "SHARED" })
      .returning();

    // Tenant-scoped write requires SET LOCAL for RLS (Decision TEN-002),
    // issued on this same transaction before touching core.* tables.
    await tx.execute(sql`SET LOCAL app.tenant_id = ${tenant!.id}`);

    await tx.insert(businessProfiles).values({
      tenantId: tenant!.id,
      name: input.businessName,
    });

    const [membership] = await tx
      .insert(memberships)
      .values({
        userId: user!.id,
        tenantId: tenant!.id,
        roleId: ownerRole.id,
        status: "ACTIVE",
      })
      .returning();

    // Activate + set canonical owner pointer atomically (INV-OWN-001).
    await tx
      .update(tenants)
      .set({ status: "ACTIVE", ownerMembershipId: membership!.id })
      .where(eq(tenants.id, tenant!.id));

    return { userId: user!.id, tenantId: tenant!.id, membershipId: membership!.id };
  });
}
