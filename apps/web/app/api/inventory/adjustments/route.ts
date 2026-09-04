import { NextRequest } from "next/server";
import { idSchema, stockAdjustmentSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { adjustStock, listStockAdjustments } from "@/lib/use-cases/returns";

export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "inventory.adjust");
    return listStockAdjustments(ctx);
  })();
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "inventory.adjust");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId || !idSchema.safeParse(operationId).success) throw new AppError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
    const parsed = stockAdjustmentSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid stock adjustment payload", { issues: parsed.error.issues });
    return adjustStock(ctx, parsed.data, operationId);
  })();
}