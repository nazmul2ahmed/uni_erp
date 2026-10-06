import { NextRequest } from "next/server";
import { searchPaymentsQuerySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { listFinancePayments } from "@/lib/use-cases/finance";

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "payments.view");
    const url = new URL(req.url);
    const parsed = searchPaymentsQuerySchema.safeParse({ partyType: url.searchParams.get("partyType") ?? undefined, partyId: url.searchParams.get("partyId") ?? undefined, dateFrom: url.searchParams.get("dateFrom") ?? undefined, dateTo: url.searchParams.get("dateTo") ?? undefined });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid payment filters");
    return listFinancePayments(ctx, parsed.data);
  })();
}