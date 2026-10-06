import { NextRequest } from "next/server";
import { changePasswordSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { requireAuth } from "@/lib/guard";
import { changePassword } from "@/lib/use-cases/password";

// Decision SEC-008: POST /api/auth/password/change { currentPassword, newPassword }
// Any signed-in user (tenant member or platform operator). Uses requireAuth, NOT requireTenantContext, so an
// account that is forced to change a one-time password can still reach it.
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const auth = await requireAuth();
    const parsed = changePasswordSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid password change", { issues: parsed.error.issues });
    return changePassword({ userId: auth.userId, sessionId: auth.sessionId }, parsed.data, req.headers.get("x-request-id") ?? undefined);
  })();
}
