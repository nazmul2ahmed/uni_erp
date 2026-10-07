import { NextRequest } from "next/server";
import { AppError } from "@erp/shared";
import { balanceSheetFilterSchema } from "@erp/validation";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { getBalanceSheet } from "@/lib/use-cases/accounting-reports";

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.view");
    const parsed = balanceSheetFilterSchema.safeParse({
      asOfDate: new URL(req.url).searchParams.get("asOfDate") ?? undefined,
    });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid balance sheet date", { issues: parsed.error.issues });
    return getBalanceSheet(ctx, parsed.data.asOfDate ?? new Date().toISOString().slice(0, 10));
  })();
}
