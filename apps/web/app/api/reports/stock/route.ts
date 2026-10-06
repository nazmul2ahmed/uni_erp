import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { getStockReport } from "@/lib/use-cases/reports";

export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "reports.view");
    return getStockReport(ctx);
  })();
}