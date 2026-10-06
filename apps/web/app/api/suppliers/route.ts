import { NextRequest } from "next/server";
import { createSupplierSchema, searchSuppliersQuerySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listSuppliers, createSupplier } from "@/lib/use-cases/supplier";

/** GET /api/suppliers — per 11 §6 [suppliers.view]. */
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "suppliers.view");

    const url = new URL(req.url);
    const parsed = searchSuppliersQuerySchema.safeParse({ q: url.searchParams.get("q") ?? undefined });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid query parameters");

    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");

    return listSuppliers(ctx, {
      q: parsed.data.q,
      limit: limitParam ? Number(limitParam) : undefined,
      offset: offsetParam ? Number(offsetParam) : undefined,
    });
  })();
}

/** POST /api/suppliers — per 11 §6 [suppliers.create] [Idempotent, optional]. */
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "suppliers.create");

    const body = await req.json().catch(() => null);
    const parsed = createSupplierSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid supplier payload", {
        issues: parsed.error.issues,
      });
    }

    return createSupplier(ctx, parsed.data);
  })();
}