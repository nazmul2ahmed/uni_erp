/**
 * Core Business Schema — Phase 1 minimal slice.
 * Per 06_DATABASE_SPECIFICATION.md v2.0 §5.1.
 *
 * Only `business_profiles` is scaffolded in Phase 1 — Customer/Supplier/
 * Item/Sales/Purchase/Inventory/Accounting land in Phase 2 (07-09).
 *
 * IMPORTANT: this table is tenant-scoped (tenant_id mandatory, per
 * 05 §21). Row Level Security policy is applied via migration SQL
 * (see migrations/0001_rls_policies.sql) — RLS is NOT expressed
 * through Drizzle's schema builder; it is raw SQL applied post-migration,
 * consistent with 05 §24-26.
 */
import { pgSchema, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./control";

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
  // Decision DOM-007 (07 §7.5a) — represented as text here for
  // Phase-1 minimalism; migrate to a proper jsonb column when the
  // Sales domain (Phase 2) actually reads it.
  settingsJson: text("settings_json").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
