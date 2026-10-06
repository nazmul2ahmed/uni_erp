import { NextRequest } from "next/server";
import { createExpenseCategorySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { createExpenseCategory, listExpenseCategories } from "@/lib/use-cases/expense";

// 11 s13: GET [expenses.view]; POST [expenses.manage]
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "expenses.view");
    return listExpenseCategories(ctx);
  })();
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "expenses.manage");
    const parsed = createExpenseCategorySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid expense category", { issues: parsed.error.issues });
    return createExpenseCategory(ctx, parsed.data);
  })();
}
