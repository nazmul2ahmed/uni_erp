import { NextRequest } from "next/server";
import { createBranchSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listBranches, createBranch } from "@/lib/use-cases/branch";

/** GET /api/tenant/branches — per 11 §15 [settings.view]. */
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.view");
    return listBranches(ctx);
  })();
}

/** POST /api/tenant/branches — per 11 §15 [settings.manage]. */
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "settings.manage");

    const body = await req.json().catch(() => null);
    const parsed = createBranchSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid branch payload", { issues: parsed.error.issues });
    }

    return createBranch(ctx, parsed.data);
  })();
}
