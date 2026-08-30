import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { archiveItem } from "@/lib/use-cases/item";

/** POST /api/items/:id/archive — per 11 §7 [catalog.update]. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.update");
    return archiveItem(ctx, params.id);
  })();
}