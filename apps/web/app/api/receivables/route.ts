import { NextRequest } from "next/server";
import { idSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { listReceivables } from "@/lib/use-cases/finance";

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.view");
    const customerId = new URL(req.url).searchParams.get("customerId") ?? undefined;
    if (customerId && !idSchema.safeParse(customerId).success) throw new AppError("VALIDATION_FAILED", "Invalid customer filter");
    return listReceivables(ctx, customerId);
  })();
}