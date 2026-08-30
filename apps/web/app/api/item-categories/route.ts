import { NextRequest } from "next/server";
import { createItemCategorySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listItemCategories, createItemCategory } from "@/lib/use-cases/catalog";

/** GET /api/item-categories — per 11 §7 [catalog.view]. */
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.view");
    return listItemCategories(ctx);
  })();
}

/** POST /api/item-categories — per 11 §7 [catalog.manage]. */
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.manage");

    const body = await req.json().catch(() => null);
    const parsed = createItemCategorySchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid category payload", { issues: parsed.error.issues });
    }

    return createItemCategory(ctx, parsed.data);
  })();
}