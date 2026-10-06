import { NextRequest } from "next/server";
import { idSchema, recordExpenseSchema, searchExpensesQuerySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { listExpenses, recordExpense } from "@/lib/use-cases/expense";

// 11 s13: GET [expenses.view]; POST [expenses.create] [Idempotent REQUIRED] -> RecordExpenseUseCase (07 14.2)
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "expenses.view");
    const params = new URL(req.url).searchParams;
    const parsed = searchExpensesQuerySchema.safeParse(Object.fromEntries([...params.entries()].filter(([, v]) => v !== "")));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid expense filters", { issues: parsed.error.issues });
    return listExpenses(ctx, parsed.data);
  })();
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "expenses.create");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId || !idSchema.safeParse(operationId).success) throw new AppError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
    const parsed = recordExpenseSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid expense", { issues: parsed.error.issues });
    return recordExpense(ctx, parsed.data, operationId);
  })();
}
