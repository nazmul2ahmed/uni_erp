import { NextRequest } from "next/server";
import { idSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { reopenAccountingPeriod } from "@/lib/use-cases/accounting-admin";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.reopen_period");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId || !idSchema.safeParse(operationId).success) throw new AppError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
    if (!idSchema.safeParse(params.id).success) throw new AppError("VALIDATION_FAILED", "Invalid accounting period id");
    return reopenAccountingPeriod(ctx, params.id, operationId);
  })();
}
