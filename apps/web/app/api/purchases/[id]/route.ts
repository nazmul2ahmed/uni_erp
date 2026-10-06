import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { getPurchase } from "@/lib/use-cases/purchase";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => { const ctx = await requireTenantContext(); await requirePermission(ctx, "purchase.view"); return getPurchase(ctx, params.id); })();
}