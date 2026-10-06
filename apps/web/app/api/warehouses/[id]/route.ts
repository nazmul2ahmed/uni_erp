import { NextRequest } from "next/server";
import { updateWarehouseSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { getWarehouse, updateWarehouse } from "@/lib/use-cases/warehouse";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.view");
    return getWarehouse(ctx, params.id);
  })();
}

/**
 * FIX (Phase 2 code-verification pass — confirmed live bug, not
 * hypothetical): this handler previously did `{ ...row, ...body }`
 * and returned it WITHOUT ever calling an update function — no
 * database write occurred. Any client "editing" a warehouse (rename,
 * deactivate) saw an apparently-successful response that vanished on
 * the next page load. Now delegates to updateWarehouse() (lib/use-
 * cases/warehouse.ts), which actually persists the change.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.manage");

    const body = await req.json().catch(() => null);
    const parsed = updateWarehouseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid warehouse payload", { issues: parsed.error.issues });
    }

    return updateWarehouse(ctx, params.id, parsed.data);
  })();
}
