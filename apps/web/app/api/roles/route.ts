import { NextRequest } from "next/server";
import { createRoleSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listRoles, createRole } from "@/lib/use-cases/role";

/** GET /api/roles — per 11 §15 [staff.manage]. Presets + tenant custom. */
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "staff.manage");
    return listRoles(ctx);
  })();
}

/** POST /api/roles — per 11 §15 [staff.manage]. Creates a tenant-custom role. */
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "staff.manage");

    const body = await req.json().catch(() => null);
    const parsed = createRoleSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid role payload", { issues: parsed.error.issues });
    }

    return createRole(ctx, parsed.data);
  })();
}
