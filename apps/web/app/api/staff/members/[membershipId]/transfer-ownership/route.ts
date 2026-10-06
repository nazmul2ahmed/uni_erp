import { NextRequest } from "next/server";
import { transferOwnershipSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireTenantContext } from "@/lib/guard";
import { transferOwnership } from "@/lib/use-cases/staff";

/**
 * POST /api/staff/members/:membershipId/transfer-ownership
 *
 * FLAGGED, DOCUMENTED EXTENSION (per 29 §8's escalation procedure —
 * not silently invented): 11_API_SPECIFICATION.md §15's endpoint list
 * does not enumerate a transfer-ownership endpoint, but 05 §75a's
 * INV-OWN-002 is otherwise a permanent dead end without one — a
 * tenant owner's membership could never have its role/status changed
 * (correctly, per the invariant) with no path forward at all. This
 * route is the minimum surface needed to make transferOwnership()
 * (lib/use-cases/staff.ts) reachable. Recommend this be formally
 * added to 11_API_SPECIFICATION.md §15 in the next documentation
 * reconciliation pass.
 *
 * No [permission] bracket check here deliberately — authorization is
 * NOT "staff.manage" (too broad for this action's sensitivity); it is
 * "must currently BE the tenant's canonical owner," enforced inside
 * transferOwnership() itself (05 §76 — this is intentionally the
 * platform's narrowest-authority mutation, mirroring 26 §11's
 * Owner-only precedent for equivalently sensitive actions).
 */
export async function POST(req: NextRequest, { params }: { params: { membershipId: string } }) {
  return apiHandler(async () => {
    const ctx = await requireTenantContext();

    const body = await req.json().catch(() => null);
    const parsed = transferOwnershipSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Ownership transfer requires explicit confirmation", { issues: parsed.error.issues });
    }

    return transferOwnership(ctx, params.membershipId);
  })();
}
