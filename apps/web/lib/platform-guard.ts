/**
 * requirePlatformOperator -- ADR-001, Decisions PLT-001 / PLT-003.
 *
 * Order matters and every step fails closed:
 *   1. feature flag off            -> 404 (the surface does not exist)
 *   2. caller outside the allowlist -> 404 (do not reveal it to the network)
 *   3. no session                  -> 401
 *   4. not an ACTIVE operator, or inactive account, or holds an ACTIVE tenant
 *      membership                  -> 403
 * Operator status is read from the database on EVERY request (never cached in the
 * session), so revoking an operator takes effect on their very next call.
 * This guard grants nothing in tenant routes: those need requireTenantContext,
 * i.e. an ACTIVE membership, which an operator cannot hold.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { headers as nextHeaders } from "next/headers";
import { db, memberships, platformOperators, users } from "@erp/db";
import { AppError } from "@erp/shared";
import { requireAuth } from "./guard";
import { clientIp, isIpAllowed, platformAdminEnabled } from "./platform-access";

export type OperatorAccess = "OK" | "NOT_OPERATOR" | "INACTIVE_ACCOUNT" | "HAS_MEMBERSHIP" | "MUST_CHANGE_PASSWORD";

export async function evaluateOperatorAccess(userId: string): Promise<OperatorAccess> {
  const operator = await db.query.platformOperators.findFirst({
    where: and(eq(platformOperators.userId, userId), eq(platformOperators.status, "ACTIVE")),
  });
  if (!operator) return "NOT_OPERATOR";
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.isActive) return "INACTIVE_ACCOUNT";
  const member = await db.query.memberships.findFirst({
    where: and(eq(memberships.userId, userId), eq(memberships.status, "ACTIVE")),
  });
  if (member) return "HAS_MEMBERSHIP";
  // Decision SEC-008: a verified operator still on the CLI-issued one-time password may only change it.
  return user.mustChangePassword ? "MUST_CHANGE_PASSWORD" : "OK";
}

const notFound = () => new AppError("RESOURCE_NOT_FOUND", "Not found");

export async function requirePlatformOperator(headers: Headers): Promise<{ userId: string; requestId: string }> {
  if (!platformAdminEnabled()) throw notFound();
  if (!isIpAllowed(clientIp(headers))) throw notFound();
  const { userId } = await requireAuth();
  const access = await evaluateOperatorAccess(userId);
  if (access === "MUST_CHANGE_PASSWORD") throw new AppError("PASSWORD_CHANGE_REQUIRED", "You must set a new password before continuing");
  if (access !== "OK") throw new AppError("PERMISSION_DENIED", "Platform operator access required");
  return { userId, requestId: headers.get("x-request-id") ?? randomUUID() };
}

/** For server components (the home page): "/platform" when the caller is a usable operator, else null. Never throws for denial. */
export async function operatorLanding(): Promise<string | null> {
  try {
    await requirePlatformOperator(nextHeaders());
    return "/platform";
  } catch (e) {
    // Only reachable after the caller proved to be a real, allowed operator, so naming the password page leaks nothing.
    if (e instanceof AppError) return e.code === "PASSWORD_CHANGE_REQUIRED" ? "/platform/account?required=1" : null;
    throw e;
  }
}
