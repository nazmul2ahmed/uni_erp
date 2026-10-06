import { NextRequest } from "next/server";
import { updateMembershipSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext, requirePermission } from "@/lib/guard";
import { updateMembership } from "@/lib/use-cases/staff";

/**
 * PATCH /api/staff/members/:membershipId — per 11 §15 [staff.manage].
 * Role/status change. Rejects with OWNER_TRANSFER_REQUIRED (409) if
 * the target is the tenant's canonical owner membership — see
 * lib/use-cases/staff.ts's updateMembership() for INV-OWN-002.
 */
export async function PATCH(req: NextRequest, { params }: { params: { membershipId: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();
    await requirePermission(ctx, "staff.manage");

    const body = await req.json().catch(() => null);
    const parsed = updateMembershipSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid membership update payload", { issues: parsed.error.issues });
    }

    return updateMembership(ctx, params.membershipId, parsed.data);
  })();
}
