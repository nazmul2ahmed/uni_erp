import { NextRequest } from "next/server";
import { createSaleSchema, idSchema, searchSalesQuerySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { completeSale, listSales } from "@/lib/use-cases/sale";

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "sales.view");
    const url = new URL(req.url);
    const parsed = searchSalesQuerySchema.safeParse({ customerId: url.searchParams.get("customerId") ?? undefined, branchId: url.searchParams.get("branchId") ?? undefined, status: url.searchParams.get("status") ?? undefined, dateFrom: url.searchParams.get("dateFrom") ?? undefined, dateTo: url.searchParams.get("dateTo") ?? undefined });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid sale filters");
    return listSales(ctx, { ...parsed.data, q: url.searchParams.get("q") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50), offset: Number(url.searchParams.get("offset") ?? 0) });
  })();
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "sales.create");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId || !idSchema.safeParse(operationId).success) throw new AppError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
    const parsed = createSaleSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid sale payload", { issues: parsed.error.issues });
    return completeSale(ctx, parsed.data, operationId);
  })();
}