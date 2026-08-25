/**
 * Seeds platform-global data: permissions catalog + preset roles.
 * Per 06_DATABASE_SPECIFICATION.md v1.0 §66 (Seed Data) and
 * 01_EXISTING_PHARMACY_SYSTEM_AUDIT.md §15 (preset role list).
 *
 * This is PLATFORM seed data (tenantId = null on roles), not tenant
 * business data — distinct from tenant onboarding seed (05 §112),
 * which runs per-tenant at provisioning time (Phase 7 scope; a
 * Phase-1 stand-in lives in CreateTenantUseCase, see apps/web/lib).
 */
import { db, permissions, roles, rolePermissions } from "../client";
import { eq, sql } from "drizzle-orm";

// Phase 1 permission catalog. Extend as each later phase's module lands
// (per 04 §34 resource.action format) — this is intentionally NOT
// exhaustive of the full platform yet.
const PERMISSION_CATALOG: Array<{ key: string; description: string }> = [
  { key: "settings.view", description: "View tenant settings" },
  { key: "settings.manage", description: "Manage tenant settings" },
  { key: "staff.manage", description: "Invite/manage staff and roles" },
  { key: "audit.view", description: "View audit logs" },
  // Forward stubs referenced by Decision DOM-007 (07 §7.5a) — inert
  // until the Sales domain (Phase 2) is implemented, but seeded now
  // so RBAC/permission plumbing is exercised end-to-end at Phase 1.
  { key: "sales.discount.override", description: "Apply discount above tenant default ceiling" },
];

const PRESET_ROLES: Array<{ key: string; name: string; permissionKeys: string[] }> = [
  {
    key: "OWNER",
    name: "Owner",
    permissionKeys: PERMISSION_CATALOG.map((p) => p.key), // Owner gets everything seeded
  },
  {
    key: "MANAGER",
    name: "Manager",
    permissionKeys: ["settings.view", "staff.manage", "audit.view"],
  },
  {
    key: "STAFF",
    name: "Staff",
    permissionKeys: ["settings.view"],
  },
];

async function main() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('erp-control-plane-seed'))`);

    console.log("[seed] upserting permission catalog...");
    const permissionIdByKey = new Map<string, string>();

    for (const p of PERMISSION_CATALOG) {
      const [permission] = await tx
        .insert(permissions)
        .values(p)
        .onConflictDoUpdate({
          target: permissions.key,
          set: { description: p.description },
        })
        .returning({ id: permissions.id });
      permissionIdByKey.set(p.key, permission!.id);
    }

    console.log("[seed] upserting preset roles (platform-global, tenantId=null)...");
    for (const r of PRESET_ROLES) {
      let role = await tx.query.roles.findFirst({
        where: (roles, { and, isNull, eq }) => and(isNull(roles.tenantId), eq(roles.key, r.key)),
      });

      if (!role) {
        const [inserted] = await tx
          .insert(roles)
          .values({ key: r.key, name: r.name, isSystemRole: true, tenantId: null })
          .returning();
        role = inserted!;
      }

      for (const permKey of r.permissionKeys) {
        const permissionId = permissionIdByKey.get(permKey);
        if (!permissionId) continue;
        await tx
          .insert(rolePermissions)
          .values({ roleId: role.id, permissionId })
          .onConflictDoNothing();
      }
    }

    console.log("[seed] done.");
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[seed] failed:", e);
    process.exit(1);
  });
