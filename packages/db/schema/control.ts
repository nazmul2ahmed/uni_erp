/**
 * Control Plane Schema
 * Per 06_DATABASE_SPECIFICATION.md v2.0 §4.
 *
 * Platform-owned. Never contains tenant BUSINESS data (05 §11-12).
 * Phase 1 scope: users, tenants, memberships, roles, permissions,
 * role_permissions — the minimum needed for register/login/
 * tenant-creation/membership-resolution (28 §4 Phase 1 exit criteria).
 */
import {
  pgSchema,
  uuid,
  text,
  timestamp,
  boolean,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const control = pgSchema("control");

/** control.users — per 06 v2.0 §4.1 (+ Decision SEC-006-SCHEMA MFA hook) */
export const users = control.table(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(), // argon2id, per 13 §2.2 — never logged/exposed
    fullName: text("full_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false), // 13 §2.6
    mfaSecretRef: text("mfa_secret_ref"), // pointer only, never raw secret — 13 §2.6
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
  }),
);

/** control.tenants — per 06 v2.0 §4.2, extended with Decision TEN-001 owner invariant field */
export const tenants = control.table("tenants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  status: text("status", {
    enum: ["PROSPECT", "PROVISIONING", "ACTIVE", "SUSPENDED", "GRACE", "ARCHIVED"],
  })
    .notNull()
    .default("PROVISIONING"), // per 05 §6 Tenant Lifecycle
  storageMode: text("storage_mode", { enum: ["SHARED", "DEDICATED"] })
    .notNull()
    .default("SHARED"), // per 05 §165, default new tenant = SHARED
  // Canonical Owner pointer — per 05 §75a (Decision TEN-001, INV-OWN-001).
  // Nullable at the type level to allow the brief transactional window
  // during provisioning (status=PROVISIONING) before the first OWNER
  // membership exists — see apps/web/lib/tenant-onboarding.ts.
  // A DB-level CHECK constraint (INV-OWN-001, migrations-manual/
  // 0002_owner_invariant.sql) enforces that this column is NEVER null
  // while status = 'ACTIVE'. Application-layer protection (INV-OWN-002:
  // reject membership-removal of the current owner; INV-OWN-003: atomic
  // transfer transaction) is the PRIMARY enforcement — the DB CHECK is
  // a null-safety backstop only, per the ratified hybrid model.
  ownerMembershipId: uuid("owner_membership_id"),
  baseCurrency: text("base_currency").notNull().default("BDT"),
  timezone: text("timezone").notNull().default("Asia/Dhaka"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** control.roles — preset + tenant-custom roles, per 06 v2.0 §4.4 */
export const roles = control.table(
  "roles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // NULL tenantId = platform preset role (Owner/Manager/Cashier/...), per 01 §15
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // e.g. "OWNER", "MANAGER"
    name: text("name").notNull(),
    isSystemRole: boolean("is_system_role").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantKeyUnique: uniqueIndex("roles_tenant_key_unique").on(t.tenantId, t.key),
  }),
);

/** control.permissions — platform-global permission catalog, per 04 §34 resource.action format */
export const permissions = control.table(
  "permissions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    key: text("key").notNull(), // e.g. "sales.create", "settings.manage"
    description: text("description").notNull(),
  },
  (t) => ({
    keyUnique: uniqueIndex("permissions_key_unique").on(t.key),
  }),
);

/** control.role_permissions — join table */
export const rolePermissions = control.table(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permissionId] }),
  }),
);

/**
 * control.memberships — per 06 v2.0 §4.3.
 * User <-> Tenant <-> Role. A user may belong to multiple tenants (05 §4-6).
 */
export const memberships = control.table(
  "memberships",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    status: text("status", { enum: ["ACTIVE", "INVITED", "SUSPENDED", "REMOVED"] })
      .notNull()
      .default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userTenantUnique: uniqueIndex("memberships_user_tenant_unique").on(t.userId, t.tenantId),
    tenantStatusIdx: index("memberships_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

/**
 * control.sessions — session store per 13 §2.1.
 * Server-side session record; the browser only holds the opaque cookie value.
 */
export const sessions = control.table(
  "sessions",
  {
    id: text("id").primaryKey(), // opaque, server-generated token
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeTenantId: uuid("active_tenant_id").references(() => tenants.id), // nullable pre-selection, 05 §43
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
);

/** control.audit_events_platform — per 06 v2.0 §4.9 */
export const auditEventsPlatform = control.table("audit_events_platform", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  tenantId: uuid("tenant_id").references(() => tenants.id),
  action: text("action").notNull(), // e.g. "tenant.created", "ownership.transferred"
  before: text("before"), // jsonb in practice; kept text-serialized for Phase-1 minimalism
  after: text("after"),
  reason: text("reason"),
  requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
