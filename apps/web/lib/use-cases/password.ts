/**
 * Authenticated password change -- Decision SEC-008 (13 2.2; the reset flow of 13 2.5 is e-mail based
 * and not built yet, this is the signed-in counterpart).
 *
 * - The CURRENT password must be proven first (a stolen session cookie alone cannot take over an
 *   account), and failures are audited and throttled: 5 failures in 15 minutes lock further attempts.
 * - The new password follows the 13 2.2 policy (length >= 10, enforced by the route schema) and must
 *   differ from the current one.
 * - In ONE transaction: new argon2id hash, the one-time-password flag cleared, every OTHER session of
 *   the account revoked (the caller stays signed in here), and an audit event written.
 * No secret is ever logged, audited or returned.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { auditEventsPlatform, db, users, withPlatformTransaction } from "@erp/db";
import type { Database } from "@erp/db";
import { AppError } from "@erp/shared";
import type { ChangePasswordInput } from "@erp/validation";
import { hashPassword, verifyPassword } from "../password";
import { destroyOtherSessionsForUser } from "../session";
import { recordOperatorAudit } from "../platform-operator";

export const PASSWORD_CHANGE_MAX_FAILURES = 5;
export const PASSWORD_CHANGE_WINDOW_MINUTES = 15;

async function recentFailures(userId: string): Promise<number> {
  const since = new Date(Date.now() - PASSWORD_CHANGE_WINDOW_MINUTES * 60_000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEventsPlatform)
    .where(and(eq(auditEventsPlatform.actorUserId, userId), eq(auditEventsPlatform.action, "user.password_change_failed"), gt(auditEventsPlatform.createdAt, since)));
  return row?.count ?? 0;
}

export async function changePassword(auth: { userId: string; sessionId: string }, input: ChangePasswordInput, requestId?: string) {
  if ((await recentFailures(auth.userId)) >= PASSWORD_CHANGE_MAX_FAILURES) {
    throw new AppError("RATE_LIMITED", `Too many incorrect attempts. Try again in ${PASSWORD_CHANGE_WINDOW_MINUTES} minutes.`);
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, auth.userId) });
  if (!user || !user.isActive) throw new AppError("AUTHENTICATION_REQUIRED", "Sign in again to continue");

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    await withPlatformTransaction((tx) => recordOperatorAudit(tx, { actorUserId: user.id, action: "user.password_change_failed", requestId }));
    throw new AppError("INVALID_CREDENTIALS", "Your current password is incorrect");
  }
  if (input.newPassword === input.currentPassword) {
    throw new AppError("VALIDATION_FAILED", "Choose a password that is different from your current one", { field: "newPassword" });
  }

  const passwordHash = await hashPassword(input.newPassword);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.update(users).set({ passwordHash, mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, user.id));
    const revoked = await destroyOtherSessionsForUser(user.id, auth.sessionId);
    await recordOperatorAudit(tx, {
      actorUserId: user.id,
      action: "user.password_changed",
      requestId,
      after: { otherSessionsRevoked: revoked, wasOneTimePassword: user.mustChangePassword },
    });
    return { changed: true as const, otherSessionsRevoked: revoked };
  });
}
