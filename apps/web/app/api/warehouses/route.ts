import { NextRequest } from "next/server";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listWarehouses, createWarehouse } from "@/lib/use-cases/warehouse";

export async function GET(_req?: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.manage");
    return listWarehouses(ctx);
  })();
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.manage");

    const body = await req.json().catch(() => null);
    if (!body || typeof body.name !== "string" || typeof body.code !== "string" || typeof body.branchId !== "string") {
      throw new AppError("VALIDATION_FAILED", "Warehouse payload requires name, code, and branchId");
    }

    return createWarehouse(ctx, {
      name: body.name,
      code: body.code,
      branchId: body.branchId,
      isActive: typeof body.isActive === "boolean" ? body.isActive : true,
    });
  })();
}
