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
  // Resolved once per request in requireTenantContext() (below), per
  // 22 §4.1 step 3's "effective permissions" precedent (there applied
  // to AI tool-catalog filtering; here it is the same resolution
  // reused for domain-layer, data-dependent permission checks that
  // requirePermission()'s static per-route gate cannot express alone
  // — e.g. DiscountThresholdPolicy, 07 §7.5a, which only needs
  // `sales.discount.override` when a SPECIFIC line/order actually
  // exceeds the tenant ceiling, not unconditionally on every sale).
  permissions: string[];
  // Decision VAN-007 (30_MODULE_VAN_SALES.md §8) — per-role discount
  // ceiling resolution needs to know WHICH role, not just whether a
  // permission is present. Resolved once per request alongside
  // permissions, same pattern, same helper-extraction discipline.
  roleKey: string;
}

function newRequestId(): string {
  return crypto.randomUUID();
}

/** Step 1 — withAuth: session must be valid. */
export async function requireAuth(): Promise<{ userId: string; sessionId: string; activeTenantId: string | null; mustChangePassword: boolean }> {
  const session = await loadSession();
  if (!session) {
    throw new AppError("AUTHENTICATION_REQUIRED", "Valid session required");
  }
  return { userId: session.userId, sessionId: session.id, activeTenantId: session.activeTenantId, mustChangePassword: session.mustChangePassword };
}

/**
 * Step 2 — withTenantContext: resolves the ACTIVE tenant from the
 * SESSION (never a client-supplied body/query tenantId), verifies
 * Membership is ACTIVE, verifies Tenant is ACTIVE.
 * Per 05 §17, §20; 13 §3.1.
 */
export async function requireTenantContext(): Promise<TenantContext> {
  const { userId, activeTenantId, mustChangePassword } = await requireAuth();

  // Decision SEC-008: an account still on a one-time password (invitation relayed by an owner, or an operator
  // password issued by the CLI) may do nothing but change it. Checked before any tenant is resolved. The flag
  // comes with the session (Decision SEC-010), so this costs no extra query.
  if (mustChangePassword) {
    throw new AppError("PASSWORD_CHANGE_REQUIRED", "You must set a new password before continuing");
  }

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
    permissions: await resolvePermissions(membership.roleId),
    roleKey: await resolveRoleKey(membership.roleId),
  };
}

/**
 * Resolves a role's machine-readable `key` (e.g. "OWNER", "STAFF"),
 * once. Extracted for the SAME reason as resolvePermissions() above —
 * single implementation, reused by test fixtures constructing a
 * TenantContext directly.
 */
export async function resolveRoleKey(roleId: string): Promise<string> {
  const role = await db.query.roles.findFirst({ where: eq(roles.id, roleId) });
  if (!role) throw new AppError("TENANT_ACCESS_DENIED", "Role not found");
  return role.key;
}

/**
 * Resolves the FULL effective permission-key set for a role, once.
 * Extracted as its own exported function (rather than inlined in
 * requireTenantContext()) so it is the SINGLE implementation both the
 * request path and test fixtures (e.g.
 * tenant-isolation.integration.test.ts's buildContext()) use to
 * construct a TenantContext — per 29 §6.1 "Do not duplicate business
 * logic," this must never have a second, drifting copy of the same
 * role -> permissions join.
 */
export async function resolvePermissions(roleId: string): Promise<string[]> {
  const rows = await db
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((row) => row.key);
}

/**
 * Step 3 — withPermission: does this membership's role include the
 * given resource.action permission? Per 04 §34, 13 §3.1.
 *
 * Reads from ctx.permissions (resolved once in requireTenantContext())
 * rather than re-querying — ctx is freshly constructed per request, so
 * this carries no staleness risk within a single request's lifetime.
 */
export async function requirePermission(ctx: TenantContext, permissionKey: string): Promise<void> {
  if (!ctx.permissions.includes(permissionKey)) {
    throw new AppError("PERMISSION_DENIED", `Missing permission: ${permissionKey}`);
  }
}

/**
 * Non-throwing permission check for use inside domain/use-case logic
 * where the caller must choose a DIFFERENT, more specific error
 * (e.g. DISCOUNT_EXCEEDED rather than a generic PERMISSION_DENIED)
 * when the permission is absent. Per 07 §7.5a's
 * `actor.permissions includes "sales.discount.override"` check shape.
 */
export function hasPermission(ctx: TenantContext, permissionKey: string): boolean {
  return ctx.permissions.includes(permissionKey);
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
