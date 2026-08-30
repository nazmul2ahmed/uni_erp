/**
 * Composed authorization guard chain.
 * Per 13_SECURITY_SPECIFICATION.md §3.1 and 11_API_SPECIFICATION.md §20.
 *
 *   withAuth -> withTenantContext -> withPermission -> withResourceOwnership
 *
 * Every guard step that cannot POSITIVELY confirm authorization denies
 * (05 §159 Fail Closed Principle, 13 §3.3) — there is no default-allow
 * branch anywhere below.
 */
import { AppError } from "@erp/shared";
import { db, memberships, tenants, roles, rolePermissions, permissions } from "@erp/db";
import { and, eq } from "drizzle-orm";
import { loadSession } from "./session";

export interface TenantContext {
  requestId: string;
  userId: string;
  tenantId: string;
  membershipId: string;
  roleId: string;
  storageMode: "SHARED" | "DEDICATED"; // per 05 §19; DEDICATED routing lands Phase 7
}

function newRequestId(): string {
  return crypto.randomUUID();
}

/** Step 1 — withAuth: session must be valid. */
export async function requireAuth(): Promise<{ userId: string; sessionId: string; activeTenantId: string | null }> {
  const session = await loadSession();
  if (!session) {
    throw new AppError("AUTHENTICATION_REQUIRED", "Valid session required");
  }
  return { userId: session.userId, sessionId: session.id, activeTenantId: session.activeTenantId };
}

/**
 * Step 2 — withTenantContext: resolves the ACTIVE tenant from the
 * SESSION (never a client-supplied body/query tenantId), verifies
 * Membership is ACTIVE, verifies Tenant is ACTIVE.
 * Per 05 §17, §20; 13 §3.1.
 */
export async function requireTenantContext(): Promise<TenantContext> {
  const { userId, activeTenantId } = await requireAuth();

  if (!activeTenantId) {
    throw new AppError("TENANT_ACCESS_DENIED", "No active tenant selected on this session");
  }

  const membership = await db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, userId),
      eq(memberships.tenantId, activeTenantId),
      eq(memberships.status, "ACTIVE"),
    ),
  });
  if (!membership) {
    // Fail closed: unresolvable membership -> deny, never default-allow (05 §159).
    throw new AppError("TENANT_ACCESS_DENIED", "No active membership for this tenant");
  }

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, activeTenantId) });
  if (!tenant) {
    throw new AppError("TENANT_ACCESS_DENIED", "Tenant not found");
  }
  if (tenant.status === "SUSPENDED") {
    throw new AppError("TENANT_SUSPENDED", "Tenant is suspended");
  }
  if (tenant.status !== "ACTIVE") {
    // PROVISIONING/GRACE/ARCHIVED/PROSPECT — none permit business API access.
    throw new AppError("TENANT_ACCESS_DENIED", `Tenant status '${tenant.status}' does not permit access`);
  }

  return {
    requestId: newRequestId(),
    userId,
    tenantId: tenant.id,
    membershipId: membership.id,
    roleId: membership.roleId,
    storageMode: tenant.storageMode as "SHARED" | "DEDICATED",
  };
}

/**
 * Step 3 — withPermission: does this membership's role include the
 * given resource.action permission? Per 04 §34, 13 §3.1.
 */
export async function requirePermission(ctx: TenantContext, permissionKey: string): Promise<void> {
  const rows = await db
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(rolePermissions.roleId, ctx.roleId), eq(permissions.key, permissionKey)));

  if (rows.length === 0) {
    throw new AppError("PERMISSION_DENIED", `Missing permission: ${permissionKey}`);
  }
}

/**
 * Step 4 — withResourceOwnership: does the requested resource actually
 * belong to ctx.tenantId? Per 05 §92, 13 §3.2 (Decision SEC-001 —
 * cross-tenant resource access returns 404, never 403, so existence
 * is never confirmed across a tenant boundary).
 *
 * `loader` should return the row's tenant_id or null/undefined if not found.
 */
export async function requireResourceOwnership(
  ctx: TenantContext,
  loader: () => Promise<{ tenantId: string } | null | undefined>,
): Promise<void> {
  const resource = await loader();
  if (!resource || resource.tenantId !== ctx.tenantId) {
    throw new AppError("RESOURCE_NOT_FOUND", "Resource not found"); // 404 per Decision SEC-001
  }
}
