import { NextRequest } from "next/server";
import { loginSchema } from "@erp/validation";
import { AppError } from "@erp/shared";
import { db, users, memberships } from "@erp/db";
import { and, eq } from "drizzle-orm";
import { apiHandler } from "@/lib/api-response";
import { verifyPassword } from "@/lib/password";
import { createSession, setActiveTenant } from "@/lib/session";
import { recordOperatorSignIn } from "@/lib/platform-operator";
import { clientIp } from "@/lib/client-ip";
import { beginLoginAttempt } from "@/lib/login-throttle";

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const body = await req.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", "Invalid login payload");
    }

    // 13 2.3 step 1 / 2.4 / 5.1, Decision SEC-009: throttle BEFORE any lookup or hashing. A locked (e-mail, IP)
    // pair or an over-active IP is refused with a generic 429 whether or not the account exists.
    const attempt = await beginLoginAttempt(parsed.data.email, clientIp(req.headers));

    const user = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });

    // Generic error regardless of which field was wrong — enumeration
    // protection, per 13 §2.3 step 4.
    const genericError = () => new AppError("INVALID_CREDENTIALS", "Invalid email or password");

    if (!user || !user.isActive) throw genericError();

    const validPassword = await verifyPassword(user.passwordHash, parsed.data.password);
    if (!validPassword) throw genericError();
    await attempt.succeeded(); // a correct password clears this (e-mail, IP) failure counter

    const sessionId = await createSession(user.id);
    await recordOperatorSignIn(user.id); // ADR-001: operator sign-ins are audited; a no-op for everyone else

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
