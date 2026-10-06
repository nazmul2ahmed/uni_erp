import { NextRequest } from "next/server";
import { createWarehouseSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listWarehouses, createWarehouse } from "@/lib/use-cases/warehouse";

/**
 * FIX (Phase 2 code-verification pass — confirmed permission-mapping
 * bug): this route previously required `catalog.manage` (meant for
 * item categories/brands/units, per 11 §7) instead of the documented
 * `settings.view`/`settings.manage` (11 §15 — warehouses are an
 * Administration concern, per 12 §3.1's "Administration → Branches /
 * Warehouses"). Corrected here rather than left as a latent bug.
 *
 * Path note: kept at /api/warehouses (flat), NOT the /api/tenant/
 * warehouses path 11 §15 literally showed — apps/web/components/
 * purchase/purchase-ui.tsx, sale-ui.tsx, and two inventory pages
 * already depend on this exact path (existing, working UI code —
 * per the Existing Code Rule, not renamed). 11_API_SPECIFICATION.md
 * §15 has been amended to reflect this as the documented path,
 * consistent with /api/customers, /api/items, /api/suppliers all
 * already being flat top-level resources rather than nested.
 */
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.view");
    return listWarehouses(ctx);
  })();
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.manage");

    const body = await req.json().catch(() => null);
    const parsed = createWarehouseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid warehouse payload", { issues: parsed.error.issues });
    }

    return createWarehouse(ctx, parsed.data);
  })();
}
