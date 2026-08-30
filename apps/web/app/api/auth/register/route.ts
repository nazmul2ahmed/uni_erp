import { NextRequest } from "next/server";
import { registerSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { apiHandler } from "@/lib/api-response";
import { registerOwnerAndTenant } from "@/lib/tenant-onboarding";
import { createSession, setActiveTenant } from "@/lib/session";

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const body = await req.json().catch(() => null);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid registration payload", {
        issues: parsed.error.flatten(),
      });
    }

    const result = await registerOwnerAndTenant(parsed.data);
    const sessionId = await createSession(result.userId);
    // Single-membership auto-select per 13 §2.3 step 6.
    await setActiveTenant(sessionId, result.tenantId);

    return { tenantId: result.tenantId, userId: result.userId };
  })();
}
