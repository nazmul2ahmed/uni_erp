import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listStockBalances } from "@/lib/use-cases/inventory";

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "inventory.view");
    const _ = new URL(req.url);
    return listStockBalances(ctx);
  })();
}
