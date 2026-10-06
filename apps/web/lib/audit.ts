/**
 * AuditLogger — per 07_CORE_DOMAIN_SPECIFICATION.md §15.1-§15.2.
 *
 * Code-review reconciliation pass, Finding B: core.audit_logs did not
 * exist anywhere in the schema prior to this file, so no Use Case had
 * anywhere to write an audit row (Sales/Purchase/Inventory Adjust/
 * Payment/Returns were all unaudited). Schema added in
 * packages/db/schema/core.ts (auditLogs) + migrations/0004_*.sql +
 * migrations-manual/0006_rls_audit_logs.sql.
 *
 * Contract (07 §15.1): "every Use Case in §7-§14 that mutates
 * financial or stock state calls AuditLogger.record as its final step,
 * inside the same transaction." recordAudit() below enforces the
 * "same transaction" half of that by requiring the caller's already-
 * tenant-scoped `tx` (never the top-level `db`) — an audit failure
 * rolls back the mutation it documents, and a rolled-back mutation
 * never leaves a phantom audit row.
 */
import { auditLogs } from "@erp/db";
import type { Database } from "@erp/db";
import type { TenantContext } from "./guard";

export interface AuditEntry {
  /** e.g. "sale.complete", "inventory.adjust" — per 07 §15.2's minimum set. */
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export async function recordAudit(tx: Database, ctx: TenantContext, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before !== undefined ? JSON.stringify(entry.before) : null,
    after: entry.after !== undefined ? JSON.stringify(entry.after) : null,
    reason: entry.reason ?? null,
    requestId: ctx.requestId,
  });
}
