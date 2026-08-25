import { NextRequest } from "next/server";
import { tenantSelectSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { db, memberships } from "@erp/db";
import { and, eq } from "drizzle-orm";
import { apiHandler } from "@/lib/api-response";
import { requireAuth } from "@/lib/guard";
import { setActiveTenant } from "@/lib/session";

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const { userId, sessionId } = await requireAuth();

    const body = await req.json().catch(() => null);
    const parsed = tenantSelectSchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid tenant selection");

    // Checks Membership per 05 §18 — the one pre-tenant-context check
    // this endpoint performs itself, since requireTenantContext() can't
    // run before a tenant IS selected.
    const membership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.userId, userId),
        eq(memberships.tenantId, parsed.data.tenantId),
        eq(memberships.status, "ACTIVE"),
      ),
    });
    if (!membership) {
      throw new AppError("TENANT_ACCESS_DENIED", "No active membership for this tenant");
    }

    await setActiveTenant(sessionId, parsed.data.tenantId);

    return { activeTenantId: parsed.data.tenantId };
  })();
}
