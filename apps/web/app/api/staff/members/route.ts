import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { listStaff } from "@/lib/use-cases/staff";

/** GET /api/staff/members — per 11 §15 [staff.manage]. */
export async function GET() {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "staff.manage");
    return listStaff(ctx);
  })();
}
