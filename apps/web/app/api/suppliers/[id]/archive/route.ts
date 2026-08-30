import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { archiveSupplier } from "@/lib/use-cases/supplier";

/** POST /api/suppliers/:id/archive — per 11 §6 [suppliers.update]. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "suppliers.update");
    return archiveSupplier(ctx, params.id);
  })();
}