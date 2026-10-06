import { NextRequest } from "next/server";
import { idSchema, reverseExpenseSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { reverseExpense } from "@/lib/use-cases/expense";

// Decision EXP-005 (08 10.3): POST [expenses.reverse] [Idempotent REQUIRED]. Body: { reason }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "expenses.reverse");
    const { id } = await params;
    if (!idSchema.safeParse(id).success) throw new AppError("VALIDATION_FAILED", "Invalid expense id");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId || !idSchema.safeParse(operationId).success) throw new AppError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
    const parsed = reverseExpenseSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid reversal", { issues: parsed.error.issues });
    return reverseExpense(ctx, id, parsed.data, operationId);
  })();
}
