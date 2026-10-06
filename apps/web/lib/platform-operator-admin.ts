/**
 * Operator administration -- ADR-001, Decision PLT-001. OWNER-ROLE ONLY.
 *
 * These functions must be given the owner-role connection (createOwnerDb). They are
 * called by the operator CLI and by tests; the web app never imports this module,
 * and the runtime role could not perform these writes anyway (0011 REVOKE).
 * Every action is audited to control.audit_events_platform with the operating-system
 * user as the reason (there is no acting user at bootstrap).
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditEventsPlatform, memberships, platformOperators, sessions, users } from "@erp/db";
import type { Database } from "@erp/db";
import { emailSchema } from "@erp/validation";
import { hashPassword } from "./password";

const normalizeEmail = (value: string): string => {
  const parsed = emailSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid email address: ${value}`);
  return parsed.data;
};

async function audit(tx: Database, by: string, action: string, after: Record<string, unknown>) {
  await tx.insert(auditEventsPlatform).values({ actorUserId: null, action, reason: by, after: JSON.stringify(after) });
}

async function activeMembershipCount(tx: Database, userId: string): Promise<number> {
  return (await tx.query.memberships.findMany({ where: and(eq(memberships.userId, userId), eq(memberships.status, "ACTIVE")) })).length;
}

/** Make an EXISTING, active, membership-free account an operator (re-activates a revoked one). */
export async function grantOperator(db: Database, emailInput: string, by: string, note?: string) {
  const email = normalizeEmail(emailInput);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const user = await tx.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) throw new Error(`No account with email ${email}. Use "create" to make a dedicated operator account.`);
    if (!user.isActive) throw new Error(`Account ${email} is deactivated`);
    if ((await activeMembershipCount(tx, user.id)) > 0) {
      throw new Error(`Account ${email} is an active member of a workspace. An operator must be a dedicated account with no tenant membership.`);
    }
    const existing = await tx.query.platformOperators.findFirst({ where: eq(platformOperators.userId, user.id) });
    if (existing?.status === "ACTIVE") return { userId: user.id, email, alreadyActive: true };
    if (existing) {
      await tx.update(platformOperators).set({ status: "ACTIVE", grantedAt: new Date(), grantedBy: by, revokedAt: null, note: note ?? existing.note }).where(eq(platformOperators.userId, user.id));
    } else {
      await tx.insert(platformOperators).values({ userId: user.id, grantedBy: by, note: note ?? null });
    }
    await audit(tx, by, "platform.operator_granted", { userId: user.id, email });
    return { userId: user.id, email, alreadyActive: false };
  });
}

/** Create a brand-new account with NO workspace and grant it operator authority. The password is returned once. */
export async function createOperatorAccount(db: Database, emailInput: string, fullName: string, by: string) {
  const email = normalizeEmail(emailInput);
  if (!fullName.trim()) throw new Error("A full name is required");
  const temporaryPassword = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(temporaryPassword);
  await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    if (await tx.query.users.findFirst({ where: eq(users.email, email) })) throw new Error(`An account with email ${email} already exists. Use "grant" only if it has no workspace membership.`);
    await tx.insert(users).values({ email, passwordHash, fullName: fullName.trim(), mustChangePassword: true });
    await audit(tx, by, "platform.operator_account_created", { email });
  });
  const granted = await grantOperator(db, email, by);
  return { ...granted, temporaryPassword };
}

export async function revokeOperator(db: Database, emailInput: string, by: string) {
  const email = normalizeEmail(emailInput);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const user = await tx.query.users.findFirst({ where: eq(users.email, email) });
    const operator = user ? await tx.query.platformOperators.findFirst({ where: eq(platformOperators.userId, user.id) }) : undefined;
    if (!user || !operator) throw new Error(`${email} is not a platform operator`);
    if (operator.status === "REVOKED") return { userId: user.id, email, alreadyRevoked: true };
    await tx.update(platformOperators).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(platformOperators.userId, user.id));
    await audit(tx, by, "platform.operator_revoked", { userId: user.id, email });
    return { userId: user.id, email, alreadyRevoked: false };
  });
}

export async function listOperators(db: Database) {
  return db
    .select({ email: users.email, fullName: users.fullName, status: platformOperators.status, grantedAt: platformOperators.grantedAt, grantedBy: platformOperators.grantedBy, revokedAt: platformOperators.revokedAt })
    .from(platformOperators)
    .innerJoin(users, eq(users.id, platformOperators.userId))
    .orderBy(platformOperators.grantedAt);
}

/**
 * Out-of-band recovery for a locked-out operator (e-mail reset, 13 2.5, does not exist yet).
 * Issues a new one-time password, forces a change at next sign-in, and revokes ALL of the
 * account's sessions (a reset implies possible prior compromise, 13 2.5 step 3).
 */
export async function resetOperatorPassword(db: Database, emailInput: string, by: string) {
  const email = normalizeEmail(emailInput);
  const temporaryPassword = randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(temporaryPassword);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const user = await tx.query.users.findFirst({ where: eq(users.email, email) });
    const operator = user ? await tx.query.platformOperators.findFirst({ where: eq(platformOperators.userId, user.id) }) : undefined;
    if (!user || !operator) throw new Error(`${email} is not a platform operator`);
    await tx.update(users).set({ passwordHash, mustChangePassword: true, updatedAt: new Date() }).where(eq(users.id, user.id));
    const revoked = await tx.delete(sessions).where(eq(sessions.userId, user.id)).returning({ id: sessions.id });
    await audit(tx, by, "platform.operator_password_reset", { userId: user.id, email, sessionsRevoked: revoked.length });
    return { userId: user.id, email, temporaryPassword, sessionsRevoked: revoked.length };
  });
}
