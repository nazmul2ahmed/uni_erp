import { NextRequest } from "next/server";
import { loginSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { db, users, memberships } from "@erp/db";
import { and, eq } from "drizzle-orm";
import { apiHandler } from "@/lib/api-response";
import { verifyPassword } from "@/lib/password";
import { createSession, setActiveTenant } from "@/lib/session";

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const body = await req.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid login payload");
    }

    // NOTE: per-(email,IP) rate limiting (13 §5.1: 5/15min) and account
    // lockout (13 §2.4) are Phase-1 TODOs — deferred to when the Redis-
    // backed rate limiter (04 §46-47) lands; not blocking Phase 1 exit
    // criteria (28 §4), but flagged here so it is not silently forgotten.

    const user = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });

    // Generic error regardless of which field was wrong — enumeration
    // protection, per 13 §2.3 step 4.
    const genericError = () => new AppError("INVALID_CREDENTIALS", "Invalid email or password");

    if (!user || !user.isActive) throw genericError();

    const validPassword = await verifyPassword(user.passwordHash, parsed.data.password);
    if (!validPassword) throw genericError();

    const sessionId = await createSession(user.id);

    const activeMemberships = await db.query.memberships.findMany({
      where: and(eq(memberships.userId, user.id), eq(memberships.status, "ACTIVE")),
    });

    if (activeMemberships.length === 1) {
      await setActiveTenant(sessionId, activeMemberships[0]!.tenantId);
    }
    // If 0 or >1, activeTenantId remains null — client calls
    // /api/auth/tenant/select next (05 §43).

    return {
      userId: user.id,
      memberships: activeMemberships.map((m) => ({ tenantId: m.tenantId })),
      autoSelectedTenant: activeMemberships.length === 1 ? activeMemberships[0]!.tenantId : null,
    };
  })();
}
