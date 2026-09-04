import { NextRequest } from "next/server";
import { returnListQuerySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { listReturns } from "@/lib/use-cases/returns";

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "returns.view");
    const url = new URL(req.url);
    const parsed = returnListQuerySchema.safeParse({ type: url.searchParams.get("type") ?? undefined, saleId: url.searchParams.get("saleId") ?? undefined, purchaseId: url.searchParams.get("purchaseId") ?? undefined });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid return filters", { issues: parsed.error.issues });
    return listReturns(ctx, parsed.data);
  })();
}