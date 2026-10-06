import { NextRequest } from "next/server";
import { updateTenantFeaturesSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listTenantFeatures, updateTenantFeatures } from "@/lib/use-cases/tenant-features";

/** GET /api/tenant/features — per 11 §15 [settings.view]. */
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.view");
    return listTenantFeatures(ctx);
  })();
}

/** PATCH /api/tenant/features — per 11 §15 [settings.manage]. Module enable/disable. */
export async function PATCH(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.manage");

    const body = await req.json().catch(() => null);
    const parsed = updateTenantFeaturesSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid feature-flag payload", { issues: parsed.error.issues });
    }

    return updateTenantFeatures(ctx, parsed.data);
  })();
}
