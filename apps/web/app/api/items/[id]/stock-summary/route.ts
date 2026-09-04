import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { getStockSummary } from "@/lib/use-cases/inventory";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "inventory.view");
    return getStockSummary(ctx, params.id);
  })();
}