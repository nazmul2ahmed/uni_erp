/**
 * Seeds platform-global data: permissions catalog + preset roles.
 * Per 06_DATABASE_SPECIFICATION.md v2.0 §4.4 (Seed Data) and
 * 01_EXISTING_PHARMACY_SYSTEM_AUDIT.md §15 (preset role list).
 *
 * This is PLATFORM seed data (tenantId = null on roles), not tenant
 * business data — distinct from tenant onboarding seed (05 §112),
 * which runs per-tenant at provisioning time (Phase 7 scope; a
 * Phase-1 stand-in lives in CreateTenantUseCase, see apps/web/lib).
 */
import { db, permissions, roles, rolePermissions } from "../client";
import { eq } from "drizzle-orm";

// Permission catalog. Extend as each later phase's module lands
// (per 04 §34 resource.action format).
//
// Phase 1 baseline (settings/staff/audit) + Phase 2 additions below
// (Customer/Supplier/Catalog/Sales/Purchase/Inventory/Returns/
// Payment/Expense/Accounting), sourced 1:1 from the bracketed
// [resource.action] tags in 11_API_SPECIFICATION.md §5-§14.
const PERMISSION_CATALOG: Array<{ key: string; description: string }> = [
  // --- Phase 1 baseline ---
  { key: "settings.view", description: "View tenant settings" },
  { key: "settings.manage", description: "Manage tenant settings" },
  { key: "staff.manage", description: "Invite/manage staff and roles" },
  { key: "audit.view", description: "View audit logs" },

  // --- Sales (11 §8, Decision DOM-006 ratified 07 §7.5a) ---
  { key: "sales.view", description: "View sales/invoices" },
  { key: "sales.create", description: "Create/complete a sale" },
  { key: "sales.cancel", description: "Cancel a completed sale" },
  { key: "sales.discount.override", description: "Apply discount above tenant default ceiling" },

  // --- Purchase (11 §9) ---
  { key: "purchase.view", description: "View purchases" },
  { key: "purchase.create", description: "Create/receive a purchase" },

  // --- Inventory (11 §10, 06 v2.0 §5.6 Decision INV-007) ---
  { key: "inventory.view", description: "View stock balances/movements" },
  { key: "inventory.adjust", description: "Post a stock adjustment" },
  { key: "inventory.transfer", description: "Transfer stock between warehouses" },
  { key: "inventory.reserve", description: "Reserve/release stock" },
  { key: "inventory.count", description: "Start/submit a stock count" },
  { key: "inventory.allow_negative_stock", description: "Toggle negative-stock allowance on an item" },

  // --- Customer / Supplier (11 §5-§6, prerequisite for Sales/Purchase) ---
  { key: "customers.view", description: "View customers" },
  { key: "customers.create", description: "Create a customer" },
  { key: "customers.update", description: "Update/archive a customer" },
  { key: "suppliers.view", description: "View suppliers" },
  { key: "suppliers.create", description: "Create a supplier" },
  { key: "suppliers.update", description: "Update/archive a supplier" },

  // --- Catalog / Item (11 §7, prerequisite for Sales/Purchase/Inventory) ---
  { key: "catalog.view", description: "View items/categories/brands/units" },
  { key: "catalog.create", description: "Create an item" },
  { key: "catalog.update", description: "Update/archive an item" },
  { key: "catalog.manage", description: "Manage categories/brands/units" },

  // --- Returns (11 §11) ---
  { key: "returns.view", description: "View returns" },
  { key: "returns.create", description: "Create a customer/supplier return" },

  // --- Payment (11 §12) ---
  { key: "payments.view", description: "View payments" },
  { key: "payments.create", description: "Record a customer/supplier payment" },

  // --- Expense (11 §13) ---
  { key: "expenses.view", description: "View expenses" },
  { key: "expenses.create", description: "Record an expense" },
  { key: "expenses.manage", description: "Manage expense categories" },

  // --- Accounting (11 §14) ---
  { key: "accounting.view", description: "View chart of accounts/journals/reports" },
  { key: "accounting.manage", description: "Manage chart of accounts" },
  { key: "accounting.post", description: "Post a manual journal entry" },
  { key: "accounting.close_period", description: "Close an accounting period" },
  {
    key: "accounting.reopen_period",
    description:
      "Reopen a closed accounting period (deliberately rare, per 08 §9.3 — holder scope unresolved, 13 §14 Q2)",
  },
];

// Preset role -> permission mapping.
//
// ASSUMPTION FLAGGED (not resolved by any source document — see 13
// §14 Q2, 08 §9.3): `accounting.reopen_period` and
// `inventory.allow_negative_stock` are seeded to OWNER only, never
// MANAGER, as a conservative default. This is tenant-overridable via
// custom role management (05 §77) and is NOT a hard platform
// invariant — flag for explicit business-decision confirmation.
const PRESET_ROLES: Array<{ key: string; name: string; permissionKeys: string[] }> = [
  {
    key: "OWNER",
    name: "Owner",
    permissionKeys: PERMISSION_CATALOG.map((p) => p.key), // Owner gets everything seeded
  },
  {
    key: "MANAGER",
    name: "Manager",
    permissionKeys: [
      "settings.view",
      "staff.manage",
      "audit.view",
      "sales.discount.override",
      "sales.view",
      "sales.create",
      "sales.cancel",
      "purchase.view",
      "purchase.create",
      "inventory.view",
      "inventory.adjust",
      "inventory.transfer",
      "inventory.reserve",
      "inventory.count",
      // inventory.allow_negative_stock intentionally OMITTED — see
      // ASSUMPTION FLAGGED note above
      "customers.view",
      "customers.create",
      "customers.update",
      "suppliers.view",
      "suppliers.create",
      "suppliers.update",
      "catalog.view",
      "catalog.create",
      "catalog.update",
      "catalog.manage",
      "returns.view",
      "returns.create",
      "payments.view",
      "payments.create",
      "expenses.view",
      "expenses.create",
      "expenses.manage",
      "accounting.view",
      "accounting.manage",
      "accounting.post",
      "accounting.close_period",
      // accounting.reopen_period intentionally OMITTED — see
      // ASSUMPTION FLAGGED note above
    ],
  },
  {
    key: "STAFF",
    name: "Staff",
    // POS/cashier-level baseline: read + transact on day-to-day
    // entities, no adjustment/accounting/settings authority.
    permissionKeys: [
      "settings.view",
      "sales.view",
      "sales.create",
      "purchase.view",
      "inventory.view",
      "customers.view",
      "customers.create",
      "suppliers.view",
      "catalog.view",
      "returns.view",
      "returns.create",
      "payments.view",
      "payments.create",
      "expenses.view",
      "expenses.create",
    ],
  },
];

async function main() {
  console.log("[seed] upserting permission catalog...");
  const permissionIdByKey = new Map<string, string>();
  for (const p of PERMISSION_CATALOG) {
    const existing = await db.query.permissions.findFirst({ where: eq(permissions.key, p.key) });
    if (existing) {
      permissionIdByKey.set(p.key, existing.id);
      continue;
    }
    const [inserted] = await db.insert(permissions).values(p).returning({ id: permissions.id });
    permissionIdByKey.set(p.key, inserted!.id);
  }

  console.log("[seed] upserting preset roles (platform-global, tenantId=null)...");
  for (const r of PRESET_ROLES) {
    let role = await db.query.roles.findFirst({
      where: (roles, { and, isNull, eq }) => and(isNull(roles.tenantId), eq(roles.key, r.key)),
    });
    if (!role) {
      const [inserted] = await db
        .insert(roles)
        .values({ key: r.key, name: r.name, isSystemRole: true, tenantId: null })
        .returning();
      role = inserted!;
    }
    for (const permKey of r.permissionKeys) {
      const permissionId = permissionIdByKey.get(permKey);
      if (!permissionId) continue;
      await db
        .insert(rolePermissions)
        .values({ roleId: role.id, permissionId })
        .onConflictDoNothing();
    }
  }
  console.log("[seed] done.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[seed] failed:", e);
    process.exit(1);
  });