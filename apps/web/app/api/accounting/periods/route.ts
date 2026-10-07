import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { listAccountingPeriods } from "@/lib/use-cases/accounting-admin";

export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.view");
    return listAccountingPeriods(ctx);
  })();
}
