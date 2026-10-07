import { NextRequest } from "next/server";
import { idSchema, openingEntrySchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { createOpeningEntry, listOpeningEntries } from "@/lib/use-cases/accounting-admin";

export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.view");
    return listOpeningEntries(ctx);
  })();
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.post");
    const operationId = req.headers.get("Idempotency-Key");
    if (!operationId || !idSchema.safeParse(operationId).success) throw new AppError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
    const parsed = openingEntrySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid opening entry", { issues: parsed.error.issues });
    return createOpeningEntry(ctx, parsed.data, operationId);
  })();
}
