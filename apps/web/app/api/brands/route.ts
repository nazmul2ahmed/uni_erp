import { NextRequest } from "next/server";
import { createBrandSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listBrands, createBrand } from "@/lib/use-cases/catalog";

/** GET /api/brands — per 11 §7 [catalog.view]. */
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.view");
    return listBrands(ctx);
  })();
}

/** POST /api/brands — per 11 §7 [catalog.manage]. */
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.manage");

    const body = await req.json().catch(() => null);
    const parsed = createBrandSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid brand payload", { issues: parsed.error.issues });
    }

    return createBrand(ctx, parsed.data);
  })();
}