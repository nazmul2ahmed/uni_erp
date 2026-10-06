/**
 * Modules Schema — Van/Route Sales (dealer field-representative custody).
 * Per 06_DATABASE_SPECIFICATION.md v2.0 §3 (modules schema group,
 * tenant-scoped, RLS applies — colocated with core/industry in Shared
 * mode) and 30_MODULE_VAN_SALES.md §9.
 *
 * This is the FIRST table set in the `modules` PostgreSQL schema —
 * `06 §3`'s schema-group registry named it, but no table existed
 * before this file. Grants (erp_app DML + ALTER DEFAULT PRIVILEGES)
 * and RLS policies are applied in a new migrations-manual file, per
 * 0003_grant_app_role.sql's own explicit note: "A follow-up
 * migrations-manual file must extend this exact pattern to them
 * [modules/industry/automation/billing/migration schemas] once those
 * schemas are introduced."
 *
 * Decision VAN-001 (30 §4): rep custody is tracked in this dedicated
 * append-only ledger (rep_stock_movements) with a derived cache
 * (rep_custody_balances) — mirroring Decision DB-001's discipline in
 * a second domain. core.stock_balances/core.stock_movements are
 * UNTOUCHED beyond the two new movement-type enum values (commerce.ts,
 * Decision VAN-002) — a rep's custody is never conflated with
 * warehouse on-hand stock.
 */
import { uuid, text, timestamp, numeric, uniqueIndex, index, pgSchema } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./control";
import { items } from "./core";
import { branches, warehouses, stockBatches } from "./commerce";

export const modules = pgSchema("modules");

/**
 * modules.rep_stock_assignments — Aggregate root, per 30 §3.
 * `rep_membership_id` has NO FK constraint here (control.memberships
 * lives in a different Drizzle schema object; a cross-pgSchema FK is
 * valid PostgreSQL but adds an import-order coupling this file avoids
 * by design — application-layer validation, per lib/use-cases/staff.ts's
 * already-established "no RLS on control.* -> explicit app-layer check"
 * discipline, is the enforcement mechanism here, consistent with how
 * this project already treats every control.* cross-reference).
 */
export const repStockAssignments = modules.table(
  "rep_stock_assignments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    repMembershipId: uuid("rep_membership_id").notNull(),
    status: text("status", { enum: ["ISSUED", "RECONCILING", "RECONCILED", "CANCELLED"] })
      .notNull()
      .default("ISSUED"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expectedReturnAt: timestamp("expected_return_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    expectedCashCollected: numeric("expected_cash_collected", { precision: 18, scale: 4 }).notNull().default("0"),
    cashRemitted: numeric("cash_remitted", { precision: 18, scale: 4 }),
    cashVariance: numeric("cash_variance", { precision: 18, scale: 4 }),
    varianceAcknowledgedBy: uuid("variance_acknowledged_by"),
    varianceNote: text("variance_note"),
    operationId: uuid("operation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantOperationUnique: uniqueIndex("rep_stock_assignments_tenant_operation_unique").on(t.tenantId, t.operationId),
    tenantRepIdx: index("rep_stock_assignments_tenant_rep_idx").on(t.tenantId, t.repMembershipId),
    tenantStatusIdx: index("rep_stock_assignments_tenant_status_idx").on(t.tenantId, t.status),
    // Decision VAN-009: at most one ISSUED/RECONCILING assignment per
    // rep. Cannot express a partial-WHERE unique index via Drizzle's
    // table-builder — declared as a plain index here (for query
    // planning), TRUE uniqueness enforced in migrations-manual, same
    // split as core.stock_balances (Decision INV-008).
  }),
);

export const repStockAssignmentLines = modules.table(
  "rep_stock_assignment_lines",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => repStockAssignments.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    batchId: uuid("batch_id").references(() => stockBatches.id),
    quantityIssued: numeric("quantity_issued", { precision: 18, scale: 4 }).notNull(),
    // Decision VAN-014: unit-cost SNAPSHOT taken at issue time (the same WAC-else-purchasePrice
    // basis that debited 1250 at issue). Every later relief of 1250 for this item/batch (field
    // sale COGS, custody write-off, reconciliation return) uses THIS cost, never today's WAC,
    // so 1250 nets to zero per assignment. DEFAULT 0 exists only so pre-VAN-014 rows migrate;
    // the module is pre-launch, so no production assignment carries the placeholder.
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0"),
    quantitySold: numeric("quantity_sold", { precision: 18, scale: 4 }).notNull().default("0"),
    quantityReturnedGood: numeric("quantity_returned_good", { precision: 18, scale: 4 }).notNull().default("0"),
    quantityReturnedDamaged: numeric("quantity_returned_damaged", { precision: 18, scale: 4 }).notNull().default("0"),
    quantityReturnedExpired: numeric("quantity_returned_expired", { precision: 18, scale: 4 }).notNull().default("0"),
  },
  (t) => ({
    tenantAssignmentIdx: index("rep_stock_assignment_lines_tenant_assignment_idx").on(t.tenantId, t.assignmentId),
  }),
);

/**
 * modules.rep_stock_movements — append-only custody ledger (30 §4).
 * Movement types deliberately include RETURN_PENDING (Decision
 * VAN-011) alongside the Flow-1/reconciliation types — see 30 §5.3.
 */
export const repStockMovements = modules.table(
  "rep_stock_movements",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => repStockAssignments.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    batchId: uuid("batch_id").references(() => stockBatches.id),
    movementType: text("movement_type", {
      enum: ["ISSUE", "SALE", "RETURN_GOOD", "RETURN_DAMAGED", "RETURN_EXPIRED", "RETURN_PENDING"],
    }).notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(), // signed
    referenceType: text("reference_type"), // SALE / CUSTODY / CUSTOMER_RETURN / RECONCILIATION
    referenceId: uuid("reference_id"), // polymorphic, no hard FK — mirrors core.stock_movements.reference_id
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    operationId: uuid("operation_id").notNull(),
  },
  (t) => ({
    tenantOperationUnique: uniqueIndex("rep_stock_movements_tenant_operation_unique").on(t.tenantId, t.operationId),
    tenantAssignmentIdx: index("rep_stock_movements_tenant_assignment_idx").on(t.tenantId, t.assignmentId),
  }),
);

/**
 * modules.rep_custody_balances — derived cache (Decision VAN-001a).
 * `quantityPendingReturn` per Decision VAN-011 — never folded into
 * `quantityOnHand` until reconciliation resolves it.
 */
export const repCustodyBalances = modules.table(
  "rep_custody_balances",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    repMembershipId: uuid("rep_membership_id").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    batchId: uuid("batch_id").references(() => stockBatches.id),
    quantityOnHand: numeric("quantity_on_hand", { precision: 18, scale: 4 }).notNull().default("0"),
    quantityPendingReturn: numeric("quantity_pending_return", { precision: 18, scale: 4 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // No literal primaryKey() here — batchId is nullable, and a
    // composite PK/UNIQUE across a nullable column does not enforce
    // "one row per key" (PostgreSQL NULL <> NULL semantics) — the
    // SAME gap already found and fixed for core.stock_balances
    // (Decision INV-008). True uniqueness: two partial unique indexes
    // in migrations-manual, not expressed here.
    tenantRepItemIdx: index("rep_custody_balances_tenant_rep_item_idx").on(t.tenantId, t.repMembershipId, t.itemId),
  }),
);
