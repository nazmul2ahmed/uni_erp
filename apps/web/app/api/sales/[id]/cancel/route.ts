import { NextRequest } from "next/server";
import { AppError } from "@erp/shared";
import { cancelSaleSchema, idSchema } from "@erp/validation";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { cancelSale } from "@/lib/use-cases/sale";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "sales.cancel");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId || !idSchema.safeParse(operationId).success) {
      throw new AppError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
    }
    const parsed = cancelSaleSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid sale cancellation payload", { issues: parsed.error.issues });
    return cancelSale(ctx, params.id, parsed.data, operationId);
  })();
}
