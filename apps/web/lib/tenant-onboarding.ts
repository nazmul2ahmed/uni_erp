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
import { accounts, branches, businessProfiles, db, memberships, roles, tenants, units, users, warehouses } from "@erp/db";
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

    // Tenant-scoped write requires setting app.tenant_id for RLS
    // (Decision TEN-002), issued on this same transaction before
    // touching core.* tables. Uses set_config() rather than a bare
    // `SET LOCAL ... = ${..}` statement — PostgreSQL's SET/SET LOCAL
    // commands do not accept bind parameters for their value; only a
    // function call like set_config() does. See packages/db/client.ts
    // withTenantTransaction's `sql_setLocal` docblock for the full
    // explanation of this bugfix (Phase 2 discovery, tenant-isolation
    // integration test suite) — this call site had the identical defect.
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant!.id}, true)`);

    await tx.insert(businessProfiles).values({
      tenantId: tenant!.id,
      name: input.businessName,
    });

    const [branch] = await tx.insert(branches).values({
      tenantId: tenant!.id,
      name: "Main Branch",
      code: "MAIN",
    }).returning({ id: branches.id });
    if (!branch) throw new AppError("INTERNAL_ERROR", "Unable to create default branch");

    await tx.insert(warehouses).values({
      tenantId: tenant!.id,
      branchId: branch.id,
      name: "Main Warehouse",
      code: "MAIN",
    });
    await tx.insert(units).values({
      tenantId: tenant!.id,
      name: "Default",
      symbol: "unit",
      isDecimal: false,
    });
    await tx.insert(accounts).values([
      { tenantId: tenant!.id, code: "1000", name: "Cash", type: "ASSET", isSystemAccount: true },
      { tenantId: tenant!.id, code: "1010", name: "Bank", type: "ASSET", isSystemAccount: true },
      { tenantId: tenant!.id, code: "1100", name: "Accounts Receivable", type: "ASSET", isSystemAccount: true },
      { tenantId: tenant!.id, code: "1200", name: "Inventory", type: "ASSET", isSystemAccount: true },
      { tenantId: tenant!.id, code: "2000", name: "Accounts Payable", type: "LIABILITY", isSystemAccount: true },
      { tenantId: tenant!.id, code: "3000", name: "Owner Equity", type: "EQUITY", isSystemAccount: true },
      { tenantId: tenant!.id, code: "4000", name: "Sales Revenue", type: "INCOME", isSystemAccount: true },
      { tenantId: tenant!.id, code: "5000", name: "Cost of Goods Sold", type: "EXPENSE", isSystemAccount: true },
    ]);

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
