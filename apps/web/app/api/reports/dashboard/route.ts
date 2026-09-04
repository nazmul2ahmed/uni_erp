import { NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { getDashboardReport } from "@/lib/use-cases/reports";

const dateFilterSchema = z.object({
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
}).refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, "dateFrom must be before dateTo");

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.view");
    const url = new URL(req.url);
    const parsed = dateFilterSchema.safeParse({ dateFrom: url.searchParams.get("dateFrom") ?? undefined, dateTo: url.searchParams.get("dateTo") ?? undefined });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid report date range", { issues: parsed.error.issues });
    return getDashboardReport(ctx, parsed.data);
  })();
}