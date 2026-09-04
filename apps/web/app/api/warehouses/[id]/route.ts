import { NextRequest } from "next/server";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { getWarehouse } from "@/lib/use-cases/warehouse";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.manage");
    return getWarehouse(ctx, params.id);
  })();
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.manage");
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new AppError("VALIDATION_FAILED", "Warehouse payload is required");
    }

    const row = await getWarehouse(ctx, params.id);
    return { ...row, ...body, updatedAt: new Date().toISOString() };
  })();
}
