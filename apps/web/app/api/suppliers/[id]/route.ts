import { NextRequest } from "next/server";
import { updateSupplierSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { getSupplier, updateSupplier } from "@/lib/use-cases/supplier";

/** GET /api/suppliers/:id — per 11 §6 [suppliers.view]. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "suppliers.view");
    return getSupplier(ctx, params.id);
  })();
}

/** PATCH /api/suppliers/:id — per 11 §6 [suppliers.update]. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "suppliers.update");

    const body = await req.json().catch(() => null);
    const parsed = updateSupplierSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid supplier payload", {
        issues: parsed.error.issues,
      });
    }

    return updateSupplier(ctx, params.id, parsed.data);
  })();
}