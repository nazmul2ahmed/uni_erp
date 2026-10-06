import { NextRequest } from "next/server";
import { idSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { listPayables } from "@/lib/use-cases/finance";

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.view");
    const supplierId = new URL(req.url).searchParams.get("supplierId") ?? undefined;
    if (supplierId && !idSchema.safeParse(supplierId).success) throw new AppError("VALIDATION_FAILED", "Invalid supplier filter");
    return listPayables(ctx, supplierId);
  })();
}