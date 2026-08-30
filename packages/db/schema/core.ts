/**
 * Core Business Schema.
 * Per 06_DATABASE_SPECIFICATION.md v2.0 §5.
 *
 * Phase 1: business_profiles only.
 * Phase 2 (this revision): Customer / Supplier / Item / ItemCategory /
 * Brand / Unit — per 06 v2.0 §5.4-§5.7 — the prerequisite entities for
 * Sales/Purchase/Inventory (07-09), which land in a subsequent
 * revision once these are migrated and verified.
 *
 * IMPORTANT: every table below is tenant-scoped (tenant_id mandatory,
 * per 05 §21). Row Level Security policies for these NEW tables are
 * applied via migrations-manual/0004_rls_policies_phase2.sql — RLS is
 * NOT expressed through Drizzle's schema builder, consistent with the
 * existing business_profiles precedent (05 §24-26).
 *
 * Partial UNIQUE constraints (e.g. phone/sku uniqueness only when the
 * value is non-null) are NOT expressed via Drizzle's `uniqueIndex()`
 * here — Drizzle 0.33's builder does not cleanly model a `WHERE`
 * clause on a unique index in a way this project has established
 * precedent for (see migrations-manual/0002_owner_invariant.sql's
 * identical reasoning for CHECK constraints). These are instead
 * applied as raw SQL in migrations-manual/0004_rls_policies_phase2.sql
 * alongside the RLS policies for the same tables.
 */
import {
  pgSchema,
  uuid,
  text,
  timestamp,
  boolean,
  numeric,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants, users } from "./control";

export const core = pgSchema("core");

export const businessProfiles = core.table("business_profiles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  logoUrl: text("logo_url"),
  phone: text("phone"),
  address: text("address"),
  invoicePrefix: text("invoice_prefix").notNull().default("INV"),
  // sales.maxDiscountPercent / maxDiscountPercentOverride /
  // discountOverrideUnlimited live inside `settings` jsonb per
  // Decision DOM-006 (07 §7.5a, ratified Phase 0.5 Reconciliation) —
  // represented as text here for Phase-1 minimalism; migrate to a
  // proper jsonb column when the Sales domain actually reads it.
  settingsJson: text("settings_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------- */
/* Catalog primitives — per 06 v2.0 §5.7                            */
/* -------------------------------------------------------------- */

/** core.units — per 06 v2.0 §5.7 */
export const units = core.table(
  "units",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    isDecimal: boolean("is_decimal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantNameUnique: uniqueIndex("units_tenant_name_unique").on(t.tenantId, t.name),
  }),
);

/** core.brands — per 06 v2.0 §5.7 */
export const brands = core.table(
  "brands",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantNameUnique: uniqueIndex("brands_tenant_name_unique").on(t.tenantId, t.name),
  }),
);

/**
 * core.item_categories — per 06 v2.0 §5.7.
 * Self-referencing (parent_id) for category hierarchy — nullable,
 * typed via AnyPgColumn to avoid a circular-initializer TS error on
 * the self-reference (standard Drizzle pattern for self-FKs).
 */
export const itemCategories = core.table(
  "item_categories",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => itemCategories.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantNameUnique: uniqueIndex("item_categories_tenant_name_unique").on(t.tenantId, t.name),
  }),
);

/* -------------------------------------------------------------- */
/* Customer / Supplier — per 06 v2.0 §5.4-§5.5                       */
/* -------------------------------------------------------------- */

/**
 * core.customers — per 06 v2.0 §5.4.
 *
 * `phone` uniqueness is conditional (UNIQUE(tenant_id, phone) WHERE
 * phone IS NOT NULL AND is_walk_in = false, per spec) — applied as a
 * raw partial-unique-index migration, NOT expressed here (see file
 * docblock). `deleted_at` is soft-delete only (reference-sensitive
 * entity, per 04 §97) — no hard DELETE use case exists for Customer.
 */
export const customers = core.table(
  "customers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["INDIVIDUAL", "ORGANIZATION"] })
      .notNull()
      .default("INDIVIDUAL"),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    openingReceivable: numeric("opening_receivable", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    isWalkIn: boolean("is_walk_in").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
  },
  (t) => ({
    tenantPhoneIdx: index("customers_tenant_phone_idx").on(t.tenantId, t.phone),
    tenantNameIdx: index("customers_tenant_name_idx").on(t.tenantId, t.name),
  }),
);

/**
 * core.suppliers — per 06 v2.0 §5.5. Structurally mirrors customers.
 * `phone` uniqueness: same conditional pattern (raw migration), but
 * suppliers has no `is_walk_in` equivalent — condition is simply
 * WHERE phone IS NOT NULL (per spec §5.5, "where applicable").
 */
export const suppliers = core.table(
  "suppliers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    contactPerson: text("contact_person"),
    openingPayable: numeric("opening_payable", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    isActive: boolean("is_active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
  },
  (t) => ({
    tenantPhoneIdx: index("suppliers_tenant_phone_idx").on(t.tenantId, t.phone),
    tenantNameIdx: index("suppliers_tenant_name_idx").on(t.tenantId, t.name),
  }),
);

/* -------------------------------------------------------------- */
/* Item — per 06 v2.0 §5.6 (AMENDED)                                 */
/* -------------------------------------------------------------- */

/**
 * core.items — per 06 v2.0 §5.6.
 *
 * Tracking flags (stock/batch/expiry/serial/rental/warranty) are
 * independent of `type`, per 02 §12 — e.g. a Pharmacy PRODUCT has
 * batch_tracked=true, expiry_tracked=true; a Decorator RENTAL_ASSET
 * has rental_tracked=true. ItemTrackingPolicy (07 §6.2) resolves the
 * AllocationStrategy from these flags at the domain layer — this
 * schema only stores the raw booleans, no strategy logic here.
 *
 * `allow_negative_stock` — per 09 §4.7 / Decision INV-007 (ratified
 * Phase 0.5 Reconciliation). Default false (safe default).
 * `low_stock_threshold` — per 23 §14.1 / Decision AUT-002. Nullable;
 * null = item never fires the StockLow automation event (opt-in).
 *
 * `sku` uniqueness is conditional (UNIQUE(tenant_id, sku) WHERE sku
 * IS NOT NULL, per spec) — applied as a raw partial-unique-index
 * migration, NOT expressed here (see file docblock).
 *
 * `tax_profile_id` is a bare nullable uuid (no FK yet) — the Tax
 * domain (per 08 §8's TaxProfile entity) has no table of its own in
 * this schema revision; deferred until the Accounting phase actually
 * needs it, per the same "don't build ahead of the owning phase"
 * discipline already applied to business_profiles' settings_json.
 */
export const items = core.table(
  "items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sku: text("sku"),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["PRODUCT", "SERVICE", "RAW_MATERIAL", "CONSUMABLE", "RENTAL_ASSET", "NON_STOCK"],
    }).notNull(),
    categoryId: uuid("category_id").references(() => itemCategories.id),
    brandId: uuid("brand_id").references(() => brands.id),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id),
    purchasePrice: numeric("purchase_price", { precision: 18, scale: 4 }).notNull().default("0"),
    sellingPrice: numeric("selling_price", { precision: 18, scale: 4 }).notNull().default("0"),
    taxProfileId: uuid("tax_profile_id"),
    stockTracked: boolean("stock_tracked").notNull().default(true),
    batchTracked: boolean("batch_tracked").notNull().default(false),
    expiryTracked: boolean("expiry_tracked").notNull().default(false),
    serialTracked: boolean("serial_tracked").notNull().default(false),
    rentalTracked: boolean("rental_tracked").notNull().default(false),
    warrantyTracked: boolean("warranty_tracked").notNull().default(false),
    lowStockThreshold: numeric("low_stock_threshold", { precision: 18, scale: 4 }),
    allowNegativeStock: boolean("allow_negative_stock").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
  },
  (t) => ({
    tenantNameIdx: index("items_tenant_name_idx").on(t.tenantId, t.name),
    tenantCategoryIdx: index("items_tenant_category_idx").on(t.tenantId, t.categoryId),
    tenantTypeIdx: index("items_tenant_type_idx").on(t.tenantId, t.type),
  }),
);