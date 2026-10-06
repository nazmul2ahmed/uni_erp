import { db, users, memberships, tenants, roles } from "@erp/db";
import { eq } from "drizzle-orm";
import { apiHandler } from "@/lib/api-response";
import { requireAuth, requireTenantContext } from "@/lib/guard";
import { AppError } from "@erp/shared";

export async function GET() {
  return apiHandler(async () => {
    const { userId, activeTenantId } = await requireAuth();

    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new AppError("USER_NOT_FOUND", "User not found");

    const rows = await db
      .select({
        tenantId: tenants.id,
        tenantName: tenants.name,
        roleKey: roles.key,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(eq(memberships.userId, userId));

    // Decision NAV-001: the caller's OWN role + permissions in the session's
    // active tenant, so the UI can show only what they can use. Resolved by the
    // same guard every API route uses (single source). Display hints only --
    // each endpoint still enforces on the server (13 s3.3). Fail closed: if the
    // membership/tenant is not usable (removed, suspended, ...) advertise nothing.
    let activeTenant: { tenantId: string; roleKey: string; permissions: string[] } | null = null;
    if (activeTenantId) {
      try {
        const ctx = await requireTenantContext();
        activeTenant = { tenantId: ctx.tenantId, roleKey: ctx.roleKey, permissions: ctx.permissions };
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
      }
    }

    return {
      user: { id: user.id, email: user.email, fullName: user.fullName, mustChangePassword: Boolean(user.mustChangePassword) },
      activeTenantId,
      activeTenant,
      memberships: rows,
    };
  })();
}
