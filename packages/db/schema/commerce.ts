/**
 * Commerce Schema — Inventory / Sales / Purchase / Payment / Accounting.
 * Per 06_DATABASE_SPECIFICATION.md v2.0 §5.2-§5.3, §5.8-§5.11, §5.14.
 *
 * This is the largest single schema addition in the project so far —
 * 17 tables, added together in ONE file (not split per-domain into
 * separate files) specifically because several of them have direct
 * FK relationships across domain boundaries (e.g. core.sale_items ->
 * core.stock_batches/core.stock_serials, core.receivables ->
 * core.sales), and one PAIR is genuinely circular:
 *
 *   core.sale_items.serial_id  -> core.stock_serials.id
 *   core.stock_serials.sale_item_id -> core.sale_items.id
 *
 * Splitting these into separate files would require a circular
 * ES-module import between them. Node/ESM circular imports CAN work
 * when usage is deferred (as it is here — every `.references()`
 * callback is a closure invoked lazily by Drizzle, not evaluated at
 * module-load time), but keeping genuinely interdependent tables in
 * one file avoids the risk entirely and matches the precedent already
 * set by core.ts's own self-referencing item_categories.parent_id.
 *
 * Table declaration order below is deliberately chosen so that only
 * ONE forward (lazy, AnyPgColumn-typed) reference is needed —
 * stock_serials.sale_item_id, which must forward-reference sale_items
 * (declared later, since sale_items itself needs stock_batches/
 * stock_serials to already exist for its own batch_id/serial_id
 * columns). Every other FK in this file references an
 * already-declared table.
 *
 * SCOPE — explicitly deferred, NOT included in this revision (flagged,
 * not silently skipped):
 *   - core.stock_counts / core.stock_count_lines (09 §9) — physical
 *     reconciliation workflow, not required for CompleteSaleUseCase/
 *     ReceivePurchaseUseCase's own happy path.
 *   - core.purchase_documents (AI OCR, 07 §8.4) — ConfirmPurchaseFromOCRUseCase
 *     is an OPTIONAL path; ReceivePurchaseUseCase works without it
 *     (manual entry path, 12 §6.1 Path A).
 *   - core.opening_entries / core.accounting_periods (08 §5.8, §9.4) —
 *     Phase 3 (Accounting Depth) concerns per the roadmap (28 §4);
 *     not required for a Sale/Purchase to post a balanced journal.
 *
 * RLS: applied via a new migrations-manual/0005_rls_policies_commerce.sql
 * (not expressed here), following the exact idempotent pattern
 * established in 0001/0004.
 *
 * Partial/conditional UNIQUE constraints and CHECK constraints (e.g.
 * journal_entries' "exactly one of debit/credit is non-zero"
 * invariant, per 08 §11 INV-ACC-001) are likewise applied as raw SQL
 * in that same migration file, not expressed via Drizzle's builder —
 * same reasoning as core.ts's existing docblock.
 */
import {
  uuid,
  text,
  timestamp,
  boolean,
  numeric,
  date,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants, users } from "./control";
import { core, customers, suppliers, items } from "./core";

/* ================================================================ */
/* Branch / Warehouse — per 06 v2.0 §5.2-§5.3                         */
/* (Prerequisite discovered during this revision's dependency trace:  */
/* core.sale_items.warehouse_id / core.purchase_items.warehouse_id    */
/* require core.warehouses, which requires core.branches — neither    */
/* existed in the schema before this file.)                           */
/* ================================================================ */

export const branches = core.table(
  "branches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    address: text("address"),
    phone: text("phone"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCodeUnique: uniqueIndex("branches_tenant_code_unique").on(t.tenantId, t.code),
  }),
);

export const warehouses = core.table(
  "warehouses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    name: text("name").notNull(),
    code: text("code").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCodeUnique: uniqueIndex("warehouses_tenant_code_unique").on(t.tenantId, t.code),
    tenantBranchIdx: index("warehouses_tenant_branch_idx").on(t.tenantId, t.branchId),
  }),
);

/* ================================================================ */
/* Purchase Domain — per 06 v2.0 §5.9                                  */
/* ================================================================ */

export const purchases = core.table(
  "purchases",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    purchaseNumber: text("purchase_number").notNull(),
    localNumber: text("local_number"), // offline-generated LOCAL-... prior to sync, per 04 §95
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    status: text("status", {
      enum: ["DRAFT", "CONFIRMED", "RECEIVED", "PAID", "PARTIALLY_PAID", "CANCELLED"],
    })
      .notNull()
      .default("DRAFT"),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    discountTotal: numeric("discount_total", { precision: 18, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 4 }).notNull().default("0"),
    grandTotal: numeric("grand_total", { precision: 18, scale: 4 }).notNull().default("0"),
    paidTotal: numeric("paid_total", { precision: 18, scale: 4 }).notNull().default("0"),
    dueTotal: numeric("due_total", { precision: 18, scale: 4 }).notNull().default("0"),
    purchaseDate: timestamp("purchase_date", { withTimezone: true }).notNull().defaultNow(),
    operationId: uuid("operation_id").notNull(),
    deviceId: uuid("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
  },
  (t) => ({
    tenantNumberUnique: uniqueIndex("purchases_tenant_number_unique").on(t.tenantId, t.purchaseNumber),
    tenantOperationUnique: uniqueIndex("purchases_tenant_operation_unique").on(t.tenantId, t.operationId),
    tenantSupplierIdx: index("purchases_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    tenantDateIdx: index("purchases_tenant_date_idx").on(t.tenantId, t.purchaseDate),
    tenantStatusIdx: index("purchases_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

/**
 * core.purchase_items — batch_number/expiry_date are INPUT capture
 * only (text/date, no FK) — per 06 v2.0 §5.9's design note, the
 * canonical stock_batches row is created separately via the
 * Inventory domain at receipt time, avoiding duplicate pharmacy
 * vocabulary in Core (01 §55).
 */
export const purchaseItems = core.table(
  "purchase_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    purchaseId: uuid("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    description: text("description"),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    costPrice: numeric("cost_price", { precision: 18, scale: 4 }).notNull(),
    sellingPrice: numeric("selling_price", { precision: 18, scale: 4 }),
    lineDiscount: numeric("line_discount", { precision: 18, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
    batchNumber: text("batch_number"),
    expiryDate: date("expiry_date"),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantPurchaseIdx: index("purchase_items_tenant_purchase_idx").on(t.tenantId, t.purchaseId),
    tenantItemIdx: index("purchase_items_tenant_item_idx").on(t.tenantId, t.itemId),
  }),
);

/* ================================================================ */
/* Inventory Domain (batches/serials) — per 06 v2.0 §5.10               */
/* Declared here, BEFORE sales/sale_items, so sale_items.batch_id/     */
/* serial_id can reference them directly (non-lazy).                   */
/* ================================================================ */

export const stockBatches = core.table(
  "stock_batches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    batchNumber: text("batch_number").notNull(),
    expiryDate: date("expiry_date"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    costPrice: numeric("cost_price", { precision: 18, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantItemBatchUnique: uniqueIndex("stock_batches_tenant_item_batch_unique").on(
      t.tenantId,
      t.itemId,
      t.batchNumber,
    ),
    tenantItemExpiryIdx: index("stock_batches_tenant_item_expiry_idx").on(t.tenantId, t.itemId, t.expiryDate),
  }),
);

/**
 * core.stock_serials — saleItemId forward-references core.sale_items
 * (declared later in this file) via AnyPgColumn, since sale_items
 * itself needs stockBatches/stockSerials to already exist for its own
 * batch_id/serial_id columns. See file docblock for the full
 * circular-reference explanation.
 */
export const stockSerials = core.table(
  "stock_serials",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    serialNumber: text("serial_number").notNull(),
    status: text("status", { enum: ["IN_STOCK", "SOLD", "RETURNED", "DAMAGED"] })
      .notNull()
      .default("IN_STOCK"),
    purchaseItemId: uuid("purchase_item_id").references(() => purchaseItems.id),
    saleItemId: uuid("sale_item_id").references((): AnyPgColumn => saleItems.id), // forward ref, see docblock
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantItemSerialUnique: uniqueIndex("stock_serials_tenant_item_serial_unique").on(
      t.tenantId,
      t.itemId,
      t.serialNumber,
    ),
  }),
);

/* ================================================================ */
/* Sales Domain — per 06 v2.0 §5.8                                    */
/* ================================================================ */

export const sales = core.table(
  "sales",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id),
    invoiceNumber: text("invoice_number").notNull(),
    localNumber: text("local_number"),
    customerId: uuid("customer_id").references(() => customers.id),
    status: text("status", {
      enum: ["DRAFT", "CONFIRMED", "PARTIALLY_PAID", "PAID", "DUE", "COMPLETED", "CANCELLED"],
    })
      .notNull()
      .default("DRAFT"),
    subtotal: numeric("subtotal", { precision: 18, scale: 4 }).notNull().default("0"),
    discountTotal: numeric("discount_total", { precision: 18, scale: 4 }).notNull().default("0"),
    taxTotal: numeric("tax_total", { precision: 18, scale: 4 }).notNull().default("0"),
    grandTotal: numeric("grand_total", { precision: 18, scale: 4 }).notNull().default("0"),
    paidTotal: numeric("paid_total", { precision: 18, scale: 4 }).notNull().default("0"),
    dueTotal: numeric("due_total", { precision: 18, scale: 4 }).notNull().default("0"),
    saleDate: timestamp("sale_date", { withTimezone: true }).notNull().defaultNow(),
    operationId: uuid("operation_id").notNull(),
    deviceId: uuid("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledReason: text("cancelled_reason"),
  },
  (t) => ({
    tenantInvoiceUnique: uniqueIndex("sales_tenant_invoice_unique").on(t.tenantId, t.invoiceNumber),
    tenantOperationUnique: uniqueIndex("sales_tenant_operation_unique").on(t.tenantId, t.operationId),
    tenantCustomerIdx: index("sales_tenant_customer_idx").on(t.tenantId, t.customerId),
    tenantDateIdx: index("sales_tenant_date_idx").on(t.tenantId, t.saleDate),
    tenantStatusIdx: index("sales_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

export const saleItems = core.table(
  "sale_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    description: text("description"),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    lineDiscount: numeric("line_discount", { precision: 18, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    lineTotal: numeric("line_total", { precision: 18, scale: 4 }).notNull(),
    batchId: uuid("batch_id").references(() => stockBatches.id),
    serialId: uuid("serial_id").references(() => stockSerials.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantSaleIdx: index("sale_items_tenant_sale_idx").on(t.tenantId, t.saleId),
    tenantItemIdx: index("sale_items_tenant_item_idx").on(t.tenantId, t.itemId),
  }),
);

/* ================================================================ */
/* Inventory Domain (movements/balances) — per 06 v2.0 §5.10             */
/* ================================================================ */

/**
 * core.stock_movements — the sole authoritative inventory source
 * (Decision DB-001, 06 §13). reference_id is a polymorphic pointer
 * (SALE/PURCHASE/RETURN/ADJUSTMENT/TRANSFER/...) with NO hard FK, per
 * spec — it may point to sales.id, purchases.id, or a future
 * returns/adjustments table row, which a single FK column cannot
 * express. Immutable once created: no UpdateStockMovement use case
 * exists by design (07 §9.1 invariant) — enforced at the domain
 * layer (no update/delete repository method), not by a DB trigger in
 * this revision.
 */
export const stockMovements = core.table(
  "stock_movements",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    batchId: uuid("batch_id").references(() => stockBatches.id),
    serialId: uuid("serial_id").references(() => stockSerials.id),
    movementType: text("movement_type", {
      enum: [
        "OPENING",
        "PURCHASE",
        "SALE",
        "CUSTOMER_RETURN",
        "SUPPLIER_RETURN",
        "ADJUSTMENT_IN",
        "ADJUSTMENT_OUT",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "RESERVATION",
        "RELEASE",
        "CONSUMPTION",
        "DAMAGE",
        "LOSS",
      ],
    }).notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(), // signed: + in, - out
    referenceType: text("reference_type"), // SALE/PURCHASE/RETURN/ADJUSTMENT/TRANSFER/...
    referenceId: uuid("reference_id"), // polymorphic, no hard FK (cross-domain)
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    operationId: uuid("operation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (t) => ({
    tenantOperationUnique: uniqueIndex("stock_movements_tenant_operation_unique").on(t.tenantId, t.operationId),
    tenantItemWarehouseDateIdx: index("stock_movements_tenant_item_warehouse_date_idx").on(
      t.tenantId,
      t.itemId,
      t.warehouseId,
      t.occurredAt,
    ),
    tenantReferenceIdx: index("stock_movements_tenant_reference_idx").on(t.tenantId, t.referenceType, t.referenceId),
  }),
);

/**
 * core.stock_balances — derived/cached current balance (Decision
 * DB-001; §49 of 02, "One Source of Truth"). Composite PK per spec.
 * weighted_avg_cost is nullable — null for batch/serial-valued items,
 * which use specific-identification costing instead (09 §6.1,
 * Decision INV-004).
 *
 * UNIQUENESS — Decision INV-008 (Phase 0.5 Reconciliation, second
 * reconciliation pass):
 *   06 v2.0 §5.10 specifies the PK as the composite
 *   (tenant_id, item_id, warehouse_id, batch_id). This cannot be
 *   expressed as a literal PostgreSQL PRIMARY KEY here, because (a)
 *   batch_id is semantically nullable (non-batch-tracked items have
 *   no batch), and (b) PostgreSQL forces every PRIMARY KEY column
 *   NOT NULL. A single UNIQUE INDEX across all four columns (the
 *   original draft of this table) does NOT close that gap either —
 *   PostgreSQL treats NULL <> NULL in unique indexes, so multiple
 *   stock_balances rows for the same (tenant_id, item_id,
 *   warehouse_id) with batch_id = NULL would NOT violate a plain
 *   unique index, silently breaking the "one balance row per
 *   item/warehouse" invariant for every non-batch-tracked item
 *   (i.e. most Electronics/general-retail items).
 *
 *   Fix: true uniqueness is enforced via TWO partial unique indexes
 *   in migrations-manual/0005_rls_policies_commerce.sql (raw SQL,
 *   same reasoning as this file's journal_entries CHECK constraint
 *   note) — one for batch_id IS NOT NULL, one for batch_id IS NULL.
 *   The index below is intentionally a plain (non-unique) index —
 *   it exists only for query performance (balance lookups by
 *   item/warehouse), NOT for uniqueness enforcement. Do not rely on
 *   it as a constraint.
 *
 *   Amendment flag: this supersedes 06 v2.0 §5.10's literal
 *   "composite PK" wording — pending merge into 06's own Amendment
 *   Ledger (§18) per Option C's dual-declaration rule.
 */
export const stockBalances = core.table(
  "stock_balances",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    batchId: uuid("batch_id").references(() => stockBatches.id),
    quantityOnHand: numeric("quantity_on_hand", { precision: 18, scale: 4 }).notNull().default("0"),
    quantityReserved: numeric("quantity_reserved", { precision: 18, scale: 4 }).notNull().default("0"),
    weightedAvgCost: numeric("weighted_avg_cost", { precision: 18, scale: 4 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // NON-unique lookup index only — see Decision INV-008 docblock
    // above. Actual uniqueness is enforced by two partial unique
    // indexes in 0005_rls_policies_commerce.sql.
    lookupIdx: index("stock_balances_lookup_idx").on(t.tenantId, t.itemId, t.warehouseId, t.batchId),
  }),
);

/* ================================================================ */
/* Payment / Receivable / Payable Domain — per 06 v2.0 §5.11             */
/* ================================================================ */

export const receivables = core.table(
  "receivables",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    balance: numeric("balance", { precision: 18, scale: 4 }).notNull(), // derived, recomputed on allocation
    status: text("status", { enum: ["OPEN", "PARTIAL", "SETTLED"] })
      .notNull()
      .default("OPEN"),
    dueDate: date("due_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCustomerIdx: index("receivables_tenant_customer_idx").on(t.tenantId, t.customerId),
    tenantSaleIdx: index("receivables_tenant_sale_idx").on(t.tenantId, t.saleId),
    tenantStatusIdx: index("receivables_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

export const payables = core.table(
  "payables",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    purchaseId: uuid("purchase_id")
      .notNull()
      .references(() => purchases.id),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    paidAmount: numeric("paid_amount", { precision: 18, scale: 4 }).notNull().default("0"),
    balance: numeric("balance", { precision: 18, scale: 4 }).notNull(),
    status: text("status", { enum: ["OPEN", "PARTIAL", "SETTLED"] })
      .notNull()
      .default("OPEN"),
    dueDate: date("due_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantSupplierIdx: index("payables_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    tenantPurchaseIdx: index("payables_tenant_purchase_idx").on(t.tenantId, t.purchaseId),
    tenantStatusIdx: index("payables_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

/**
 * core.payments — party_id is polymorphic (CUSTOMER or SUPPLIER,
 * per party_type) — NO FK, per spec, since a single column cannot
 * reference two different tables conditionally.
 */
export const payments = core.table(
  "payments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partyType: text("party_type", { enum: ["CUSTOMER", "SUPPLIER"] }).notNull(),
    partyId: uuid("party_id").notNull(), // polymorphic, no hard FK
    direction: text("direction", { enum: ["IN", "OUT"] }).notNull(),
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    method: text("method", {
      enum: ["CASH", "BANK", "MFS", "CARD", "CHEQUE", "ONLINE", "OTHER"],
    }).notNull(),
    referenceNo: text("reference_no"),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    operationId: uuid("operation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (t) => ({
    tenantOperationUnique: uniqueIndex("payments_tenant_operation_unique").on(t.tenantId, t.operationId),
    tenantPartyIdx: index("payments_tenant_party_idx").on(t.tenantId, t.partyType, t.partyId),
    tenantPaidAtIdx: index("payments_tenant_paid_at_idx").on(t.tenantId, t.paidAt),
  }),
);

/**
 * core.payment_allocations — allocated_to_id is polymorphic
 * (SALE/PURCHASE/EXPENSE/ADVANCE, per allocated_to_type) — NO FK,
 * same reasoning as payments.party_id.
 */
export const paymentAllocations = core.table(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    allocatedToType: text("allocated_to_type", { enum: ["SALE", "PURCHASE", "EXPENSE", "ADVANCE"] }).notNull(),
    allocatedToId: uuid("allocated_to_id"), // polymorphic, nullable for ADVANCE (unallocated remainder)
    amount: numeric("amount", { precision: 18, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantPaymentIdx: index("payment_allocations_tenant_payment_idx").on(t.tenantId, t.paymentId),
  }),
);

/* ================================================================ */
/* Accounting Domain — per 06 v2.0 §5.14                               */
/* ================================================================ */

export const accounts = core.table(
  "accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] }).notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => accounts.id), // self-ref, same pattern as item_categories
    isSystemAccount: boolean("is_system_account").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCodeUnique: uniqueIndex("accounts_tenant_code_unique").on(t.tenantId, t.code),
  }),
);

/**
 * core.journals — reference_id is polymorphic (SALE/PURCHASE/
 * PAYMENT/EXPENSE/REVERSAL/MANUAL_ADJUSTMENT/...) — NO FK, same
 * polymorphic-reference pattern as stock_movements.reference_id.
 */
export const journals = core.table(
  "journals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    referenceType: text("reference_type").notNull(),
    referenceId: uuid("reference_id"), // polymorphic, no hard FK
    description: text("description"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    operationId: uuid("operation_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (t) => ({
    tenantOperationUnique: uniqueIndex("journals_tenant_operation_unique").on(t.tenantId, t.operationId),
    tenantReferenceIdx: index("journals_tenant_reference_idx").on(t.tenantId, t.referenceType, t.referenceId),
    tenantPostedAtIdx: index("journals_tenant_posted_at_idx").on(t.tenantId, t.postedAt),
  }),
);

/**
 * core.journal_entries — INV-ACC-001 (08 §11: "exactly one of
 * {debit, credit} > 0, never both") is enforced via a raw-SQL CHECK
 * constraint in the accompanying RLS/constraint migration, not
 * expressible cleanly via Drizzle's column builder for a
 * cross-column condition — same reasoning as the owner-invariant
 * CHECK constraint (0002_owner_invariant.sql).
 */
export const journalEntries = core.table(
  "journal_entries",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    journalId: uuid("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    debit: numeric("debit", { precision: 18, scale: 4 }).notNull().default("0"),
    credit: numeric("credit", { precision: 18, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantJournalIdx: index("journal_entries_tenant_journal_idx").on(t.tenantId, t.journalId),
    tenantAccountIdx: index("journal_entries_tenant_account_idx").on(t.tenantId, t.accountId),
  }),
);