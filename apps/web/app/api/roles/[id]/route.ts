import { NextRequest } from "next/server";
import { updateRoleSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { updateRole } from "@/lib/use-cases/role";

/**
 * PATCH /api/roles/:id — per 11 §15 [staff.manage].
 * Preset/system roles are unreachable here (404, not 403) — see
 * lib/use-cases/role.ts's updateRole() docblock.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "staff.manage");

    const body = await req.json().catch(() => null);
    const parsed = updateRoleSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid role payload", { issues: parsed.error.issues });
    }

    return updateRole(ctx, params.id, parsed.data);
  })();
}
