import { db, users, memberships, tenants, roles } from "@erp/db";
import { eq } from "drizzle-orm";
import { apiHandler } from "@/lib/api-response";
import { requireAuth } from "@/lib/guard";
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

    return {
      user: { id: user.id, email: user.email, fullName: user.fullName },
      activeTenantId,
      memberships: rows,
    };
  })();
}
