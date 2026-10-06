import { NextRequest } from "next/server";
import { updateItemSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { getItem, updateItem } from "@/lib/use-cases/item";

/** GET /api/items/:id — per 11 §7 [catalog.view]. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.view");
    return getItem(ctx, params.id);
  })();
}

/** PATCH /api/items/:id — per 11 §7 [catalog.update]. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.update");

    const body = await req.json().catch(() => null);
    const parsed = updateItemSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid item payload", { issues: parsed.error.issues });
    }

    return updateItem(ctx, params.id, parsed.data);
  })();
}