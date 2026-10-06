/**
 * Operator audit + membership guard helpers (ADR-001, Decision PLT-001).
 * Writes control.audit_events_platform (06 s4.9). Runs on the runtime role,
 * which may INSERT audit rows but can no longer touch platform_operators.
 */
import { and, eq } from "drizzle-orm";
import { auditEventsPlatform, db, platformOperators, withPlatformTransaction } from "@erp/db";
import type { Database } from "@erp/db";

export async function isActiveOperator(userId: string, conn: Database = db): Promise<boolean> {
  const row = await conn.query.platformOperators.findFirst({
    where: and(eq(platformOperators.userId, userId), eq(platformOperators.status, "ACTIVE")),
  });
  return Boolean(row);
}

export interface OperatorAuditEntry {
  /** null only for out-of-band actions with no user (the CLI); then `reason` names who ran it. */
  actorUserId: string | null;
  action: string;
  tenantId?: string | null;
  requestId?: string;
  reason?: string;
  after?: unknown;
}

export async function recordOperatorAudit(tx: Database, entry: OperatorAuditEntry): Promise<void> {
  await tx.insert(auditEventsPlatform).values({
    actorUserId: entry.actorUserId,
    tenantId: entry.tenantId ?? null,
    action: entry.action,
    after: entry.after !== undefined ? JSON.stringify(entry.after) : null,
    reason: entry.reason ?? null,
    requestId: entry.requestId ?? null,
  });
}

/** Called after a successful login. Audits operator sign-ins only; a no-op for every other account. */
export async function recordOperatorSignIn(userId: string, requestId?: string): Promise<void> {
  if (!(await isActiveOperator(userId))) return;
  await withPlatformTransaction((tx) => recordOperatorAudit(tx, { actorUserId: userId, action: "platform.operator_signed_in", requestId }));
}
