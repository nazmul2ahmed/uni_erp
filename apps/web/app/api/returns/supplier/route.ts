import { NextRequest } from "next/server";
import { idSchema, supplierReturnSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { completeSupplierReturn } from "@/lib/use-cases/returns";

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "returns.create");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId || !idSchema.safeParse(operationId).success) throw new AppError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
    const parsed = supplierReturnSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid supplier return payload", { issues: parsed.error.issues });
    return completeSupplierReturn(ctx, parsed.data, operationId);
  })();
}