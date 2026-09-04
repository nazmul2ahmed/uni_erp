import { NextRequest } from "next/server";
import { createPurchaseSchema, searchPurchasesQuerySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { listPurchases, receivePurchase } from "@/lib/use-cases/purchase";

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext(); await requirePermission(ctx, "purchase.view");
    const url = new URL(req.url);
    const parsed = searchPurchasesQuerySchema.safeParse({ supplierId: url.searchParams.get("supplierId") ?? undefined, branchId: url.searchParams.get("branchId") ?? undefined, status: url.searchParams.get("status") ?? undefined, dateFrom: url.searchParams.get("dateFrom") ?? undefined, dateTo: url.searchParams.get("dateTo") ?? undefined });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid purchase filters");
    return listPurchases(ctx, { ...parsed.data, q: url.searchParams.get("q") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50), offset: Number(url.searchParams.get("offset") ?? 0) });
  })();
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext(); await requirePermission(ctx, "purchase.create");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId) throw new AppError("VALIDATION_FAILED", "Idempotency-Key header is required");
    const parsed = createPurchaseSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid purchase payload", { issues: parsed.error.issues });
    return receivePurchase(ctx, parsed.data, operationId);
  })();
}