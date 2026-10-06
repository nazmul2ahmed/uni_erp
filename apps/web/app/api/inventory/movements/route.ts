import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listStockMovements } from "@/lib/use-cases/inventory";

export async function GET(_req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "inventory.view");
    return listStockMovements(ctx);
  })();
}
