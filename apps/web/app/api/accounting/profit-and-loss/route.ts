import { NextRequest } from "next/server";
import { AppError } from "@erp/shared";
import { accountingDateFilterSchema } from "@erp/validation";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { getProfitAndLoss } from "@/lib/use-cases/profit-loss";

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.view");
    const url = new URL(req.url);
    const parsed = accountingDateFilterSchema.safeParse({
      dateFrom: url.searchParams.get("dateFrom") ?? undefined,
      dateTo: url.searchParams.get("dateTo") ?? undefined,
    });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid report date range", { issues: parsed.error.issues });
    return getProfitAndLoss(ctx, parsed.data);
  })();
}
