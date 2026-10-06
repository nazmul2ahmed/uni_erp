import { NextRequest } from "next/server";
import { createUnitSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listUnits, createUnit } from "@/lib/use-cases/catalog";

/** GET /api/units — per 11 §7 [catalog.view]. */
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.view");
    return listUnits(ctx);
  })();
}

/** POST /api/units — per 11 §7 [catalog.manage]. */
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.manage");

    const body = await req.json().catch(() => null);
    const parsed = createUnitSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid unit payload", { issues: parsed.error.issues });
    }

    return createUnit(ctx, parsed.data);
  })();
}