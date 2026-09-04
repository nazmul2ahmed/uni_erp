import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { getReturn } from "@/lib/use-cases/returns";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "returns.view");
    return getReturn(ctx, params.id);
  })();
}