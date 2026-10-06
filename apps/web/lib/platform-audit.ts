/**
 * PlatformAuditLogger — per 06_DATABASE_SPECIFICATION.md §4.9 and
 * 05_MULTI_TENANT_ARCHITECTURE.md §122-123 ("Platform Audit ≠ Tenant
 * Business Audit — দুইটির retention/access policy আলাদা হতে পারে").
 *
 * Staff/Membership/Role mutations are CONTROL-PLANE actions (who can
 * access a tenant, and with what authority) — they are not tenant
 * BUSINESS data in the sense `07` §15.2's audit table enumerates
 * (Sales/Purchase/Inventory/Payment/Returns/Accounting). Writing them
 * to `core.audit_logs` would blur exactly the Control-Plane/Business-
 * Plane boundary `05` §11-13 and `26` §2 draw deliberately elsewhere
 * in this codebase — this is the same class of distinction, applied
 * here for the first time to a genuinely control-plane mutation.
 *
 * Uses `control.audit_events_platform` (schema/control.ts), already
 * defined but previously unused by any Use Case.
 */
import { auditEventsPlatform } from "@erp/db";
import type { Database } from "@erp/db";
import type { TenantContext } from "./guard";

export interface PlatformAuditEntry {
  /** e.g. "membership.invited", "membership.role_changed", "ownership.transferred" */
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export async function recordPlatformAudit(tx: Database, ctx: TenantContext, entry: PlatformAuditEntry): Promise<void> {
  await tx.insert(auditEventsPlatform).values({
    actorUserId: ctx.userId,
    tenantId: ctx.tenantId,
    action: entry.action,
    before: entry.before !== undefined ? JSON.stringify(entry.before) : null,
    after: entry.after !== undefined ? JSON.stringify(entry.after) : null,
    reason: entry.reason ?? null,
    requestId: ctx.requestId,
  });
}
