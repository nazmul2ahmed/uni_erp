import { NextRequest } from "next/server";
import { idSchema, recordSupplierPaymentSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { recordSupplierPayment } from "@/lib/use-cases/finance";

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "payments.create");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId || !idSchema.safeParse(operationId).success) throw new AppError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
    const parsed = recordSupplierPaymentSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid supplier payment", { issues: parsed.error.issues });
    return recordSupplierPayment(ctx, parsed.data, operationId);
  })();
}