/**
 * Role application-layer use cases (tenant-custom roles).
 * Per 06_DATABASE_SPECIFICATION.md §4.4 and 11_API_SPECIFICATION.md §15.
 *
 * Like lib/use-cases/staff.ts, operates entirely on control.* tables
 * (no RLS — withPlatformTransaction + explicit tenantId filtering).
 * Preset/system roles (tenantId=null) are structurally unreachable by
 * createRole/updateRole's tenant-scoped queries — see role.ts's own
 * validation-layer docblock for why this is deliberate, not an
 * oversight.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { permissions, rolePermissions, roles, withPlatformTransaction } from "@erp/db";
import type { Database } from "@erp/db";
import { AppError } from "@erp/shared";
import type { CreateRoleInput, UpdateRoleInput } from "@erp/validation";
import type { TenantContext } from "../guard";

const PG_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

export async function listRoles(ctx: TenantContext) {
  return withPlatformTransaction(async (tx) => {
    const roleRows = await tx.query.roles.findMany({
      where: or(isNull(roles.tenantId), eq(roles.tenantId, ctx.tenantId)),
      orderBy: (r, { asc }) => [asc(r.isSystemRole), asc(r.name)],
    });
    const roleIds = roleRows.map((r) => r.id);
    const permRows = roleIds.length
      ? await tx
          .select({ roleId: rolePermissions.roleId, key: permissions.key })
          .from(rolePermissions)
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(inArray(rolePermissions.roleId, roleIds))
      : [];
    const permsByRole = new Map<string, string[]>();
    for (const row of permRows) {
      const list = permsByRole.get(row.roleId) ?? [];
      list.push(row.key);
      permsByRole.set(row.roleId, list);
    }
    return roleRows.map((role) => ({ ...role, permissionKeys: permsByRole.get(role.id) ?? [] }));
  });
}

async function resolvePermissionIds(tx: Database, keys: string[]): Promise<string[]> {
  const rows = await tx.select({ id: permissions.id, key: permissions.key }).from(permissions).where(inArray(permissions.key, keys));
  const found = new Set(rows.map((r) => r.key));
  const unknown = keys.filter((k) => !found.has(k));
  if (unknown.length > 0) {
    throw new AppError("VALIDATION_FAILED", "Unknown permission key(s)", { unknown });
  }
  return rows.map((r) => r.id);
}

export async function createRole(ctx: TenantContext, input: CreateRoleInput) {
  return withPlatformTransaction(async (tx) => {
    const permissionIds = await resolvePermissionIds(tx, input.permissionKeys);
    try {
      const [role] = await tx.insert(roles).values({ tenantId: ctx.tenantId, key: input.key, name: input.name, isSystemRole: false }).returning();
      if (permissionIds.length > 0) {
        await tx.insert(rolePermissions).values(permissionIds.map((permissionId) => ({ roleId: role!.id, permissionId })));
      }
      return { ...role!, permissionKeys: input.permissionKeys };
    } catch (e) {
      if (isUniqueViolation(e)) {
        // roles_tenant_key_unique (schema/control.ts).
        throw new AppError("DUPLICATE_RESOURCE", "A role with this key already exists for this tenant", { field: "key" });
      }
      throw e;
    }
  });
}

export async function updateRole(ctx: TenantContext, id: string, input: UpdateRoleInput) {
  return withPlatformTransaction(async (tx) => {
    // Tenant-scoped WHERE — a preset role (tenantId=null) or another
    // tenant's custom role simply isn't found here (404, not 403,
    // per Decision SEC-001, 13 §3.2) rather than needing a separate
    // isSystemRole branch.
    const role = await tx.query.roles.findFirst({ where: and(eq(roles.id, id), eq(roles.tenantId, ctx.tenantId)) });
    if (!role) throw new AppError("RESOURCE_NOT_FOUND", "Role not found");

    if (input.name) {
      await tx.update(roles).set({ name: input.name }).where(eq(roles.id, id));
    }
    if (input.permissionKeys) {
      const permissionIds = await resolvePermissionIds(tx, input.permissionKeys);
      // Replace wholesale within the same transaction — simpler and
      // less error-prone than a diff/patch of the join table, and
      // this is a low-frequency admin action (role editing), not a
      // hot path where the extra DELETE+INSERT cost matters.
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      if (permissionIds.length > 0) {
        await tx.insert(rolePermissions).values(permissionIds.map((permissionId) => ({ roleId: id, permissionId })));
      }
    }

    const updated = await tx.query.roles.findFirst({ where: eq(roles.id, id) });
    const currentPermRows = await tx
      .select({ key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(rolePermissions.roleId, id));
    return { ...updated!, permissionKeys: currentPermRows.map((r) => r.key) };
  });
}
