import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { getSale } from "@/lib/use-cases/sale";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "sales.view");
    return getSale(ctx, params.id);
  })();
}