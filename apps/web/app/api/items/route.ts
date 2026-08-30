import { NextRequest } from "next/server";
import { createItemSchema, searchItemsQuerySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listItems, createItem } from "@/lib/use-cases/item";

/** GET /api/items — per 11 §7 [catalog.view]. */
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.view");

    const url = new URL(req.url);
    const parsed = searchItemsQuerySchema.safeParse({ q: url.searchParams.get("q") ?? undefined });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid query parameters");

    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");

    return listItems(ctx, {
      q: parsed.data.q,
      limit: limitParam ? Number(limitParam) : undefined,
      offset: offsetParam ? Number(offsetParam) : undefined,
    });
  })();
}

/** POST /api/items — per 11 §7 [catalog.create] [Idempotent, optional]. */
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "catalog.create");

    const body = await req.json().catch(() => null);
    const parsed = createItemSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid item payload", { issues: parsed.error.issues });
    }

    return createItem(ctx, parsed.data);
  })();
}