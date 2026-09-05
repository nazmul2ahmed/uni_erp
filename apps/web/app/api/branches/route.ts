import { branches, withTenantTransaction } from "@erp/db";
import { eq } from "drizzle-orm";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";

export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.view");
    return withTenantTransaction(ctx.tenantId, async (tx) => tx.query.branches.findMany({ where: eq(branches.tenantId, ctx.tenantId), orderBy: branches.name }));
  })();
}
