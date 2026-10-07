import { NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requirePermission, requireTenantContext } from "@/lib/guard";
import { getPayableAging } from "@/lib/use-cases/accounting-reports";

const schema = z.object({ asOfDate: z.string().date().optional() });

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "accounting.view");
    const parsed = schema.safeParse({ asOfDate: new URL(req.url).searchParams.get("asOfDate") ?? undefined });
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid aging date", { issues: parsed.error.issues });
    return getPayableAging(ctx, parsed.data.asOfDate ?? new Date().toISOString().slice(0, 10));
  })();
}
