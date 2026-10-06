import { NextRequest } from "next/server";
import { inviteStaffSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { inviteStaff } from "@/lib/use-cases/staff";

/** POST /api/staff/invite — per 11 §15 [staff.manage]. */
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "staff.manage");

    const body = await req.json().catch(() => null);
    const parsed = inviteStaffSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid staff invite payload", { issues: parsed.error.issues });
    }

    return inviteStaff(ctx, parsed.data);
  })();
}
