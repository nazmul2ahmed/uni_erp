CREATE TABLE IF NOT EXISTS "core"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"parent_id" uuid,
	"is_system_account" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" text,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" uuid,
	"description" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."payables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"paid_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"balance" numeric(18, 4) NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"due_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"allocated_to_type" text NOT NULL,
	"allocated_to_id" uuid,
	"amount" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_type" text NOT NULL,
	"party_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"method" text NOT NULL,
	"reference_no" text,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text,
	"quantity" numeric(18, 4) NOT NULL,
	"cost_price" numeric(18, 4) NOT NULL,
	"selling_price" numeric(18, 4),
	"line_discount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_total" numeric(18, 4) NOT NULL,
	"batch_number" text,
	"expiry_date" date,
	"warehouse_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"purchase_number" text NOT NULL,
	"local_number" text,
	"supplier_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"discount_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"grand_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"paid_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"due_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"purchase_date" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid NOT NULL,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."receivables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"paid_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"balance" numeric(18, 4) NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"due_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."sale_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"line_discount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_total" numeric(18, 4) NOT NULL,
	"batch_id" uuid,
	"serial_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"local_number" text,
	"customer_id" uuid,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"discount_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"grand_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"paid_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"due_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"sale_date" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid NOT NULL,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."stock_balances" (
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity_on_hand" numeric(18, 4) DEFAULT '0' NOT NULL,
	"quantity_reserved" numeric(18, 4) DEFAULT '0' NOT NULL,
	"weighted_avg_cost" numeric(18, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."stock_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_number" text NOT NULL,
	"expiry_date" date,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supplier_id" uuid,
	"cost_price" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"batch_id" uuid,
	"serial_id" uuid,
	"movement_type" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"reference_type" text,
	"reference_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."stock_serials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"status" text DEFAULT 'IN_STOCK' NOT NULL,
	"purchase_item_id" uuid,
	"sale_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."accounts" ADD CONSTRAINT "accounts_parent_id_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."journal_entries" ADD CONSTRAINT "journal_entries_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "core"."journals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."journal_entries" ADD CONSTRAINT "journal_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."journals" ADD CONSTRAINT "journals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."journals" ADD CONSTRAINT "journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."payables" ADD CONSTRAINT "payables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."payables" ADD CONSTRAINT "payables_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "core"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."payables" ADD CONSTRAINT "payables_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "core"."purchases"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."payment_allocations" ADD CONSTRAINT "payment_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "core"."payments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchase_items" ADD CONSTRAINT "purchase_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "core"."purchases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchase_items" ADD CONSTRAINT "purchase_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchase_items" ADD CONSTRAINT "purchase_items_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "core"."warehouses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchases" ADD CONSTRAINT "purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchases" ADD CONSTRAINT "purchases_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchases" ADD CONSTRAINT "purchases_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "core"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchases" ADD CONSTRAINT "purchases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchases" ADD CONSTRAINT "purchases_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."receivables" ADD CONSTRAINT "receivables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."receivables" ADD CONSTRAINT "receivables_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "core"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."receivables" ADD CONSTRAINT "receivables_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "core"."sales"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sale_items" ADD CONSTRAINT "sale_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sale_items" ADD CONSTRAINT "sale_items_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "core"."sales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sale_items" ADD CONSTRAINT "sale_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sale_items" ADD CONSTRAINT "sale_items_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."stock_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sale_items" ADD CONSTRAINT "sale_items_serial_id_stock_serials_id_fk" FOREIGN KEY ("serial_id") REFERENCES "core"."stock_serials"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sale_items" ADD CONSTRAINT "sale_items_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "core"."warehouses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sales" ADD CONSTRAINT "sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sales" ADD CONSTRAINT "sales_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sales" ADD CONSTRAINT "sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "core"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sales" ADD CONSTRAINT "sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sales" ADD CONSTRAINT "sales_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_balances" ADD CONSTRAINT "stock_balances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "core"."warehouses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_balances" ADD CONSTRAINT "stock_balances_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."stock_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_batches" ADD CONSTRAINT "stock_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_batches" ADD CONSTRAINT "stock_batches_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_batches" ADD CONSTRAINT "stock_batches_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "core"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_movements" ADD CONSTRAINT "stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "core"."warehouses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_movements" ADD CONSTRAINT "stock_movements_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."stock_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_movements" ADD CONSTRAINT "stock_movements_serial_id_stock_serials_id_fk" FOREIGN KEY ("serial_id") REFERENCES "core"."stock_serials"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_movements" ADD CONSTRAINT "stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_serials" ADD CONSTRAINT "stock_serials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_serials" ADD CONSTRAINT "stock_serials_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_serials" ADD CONSTRAINT "stock_serials_purchase_item_id_purchase_items_id_fk" FOREIGN KEY ("purchase_item_id") REFERENCES "core"."purchase_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_serials" ADD CONSTRAINT "stock_serials_sale_item_id_sale_items_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "core"."sale_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."warehouses" ADD CONSTRAINT "warehouses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."warehouses" ADD CONSTRAINT "warehouses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_tenant_code_unique" ON "core"."accounts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branches_tenant_code_unique" ON "core"."branches" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_tenant_journal_idx" ON "core"."journal_entries" USING btree ("tenant_id","journal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_entries_tenant_account_idx" ON "core"."journal_entries" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "journals_tenant_operation_unique" ON "core"."journals" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journals_tenant_reference_idx" ON "core"."journals" USING btree ("tenant_id","reference_type","reference_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journals_tenant_posted_at_idx" ON "core"."journals" USING btree ("tenant_id","posted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payables_tenant_supplier_idx" ON "core"."payables" USING btree ("tenant_id","supplier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payables_tenant_purchase_idx" ON "core"."payables" USING btree ("tenant_id","purchase_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payables_tenant_status_idx" ON "core"."payables" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_allocations_tenant_payment_idx" ON "core"."payment_allocations" USING btree ("tenant_id","payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_tenant_operation_unique" ON "core"."payments" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_tenant_party_idx" ON "core"."payments" USING btree ("tenant_id","party_type","party_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_tenant_paid_at_idx" ON "core"."payments" USING btree ("tenant_id","paid_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_items_tenant_purchase_idx" ON "core"."purchase_items" USING btree ("tenant_id","purchase_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_items_tenant_item_idx" ON "core"."purchase_items" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchases_tenant_number_unique" ON "core"."purchases" USING btree ("tenant_id","purchase_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchases_tenant_operation_unique" ON "core"."purchases" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchases_tenant_supplier_idx" ON "core"."purchases" USING btree ("tenant_id","supplier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchases_tenant_date_idx" ON "core"."purchases" USING btree ("tenant_id","purchase_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchases_tenant_status_idx" ON "core"."purchases" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receivables_tenant_customer_idx" ON "core"."receivables" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receivables_tenant_sale_idx" ON "core"."receivables" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receivables_tenant_status_idx" ON "core"."receivables" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_items_tenant_sale_idx" ON "core"."sale_items" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_items_tenant_item_idx" ON "core"."sale_items" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tenant_invoice_unique" ON "core"."sales" USING btree ("tenant_id","invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tenant_operation_unique" ON "core"."sales" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_customer_idx" ON "core"."sales" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_date_idx" ON "core"."sales" USING btree ("tenant_id","sale_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_status_idx" ON "core"."sales" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_balances_lookup_idx" ON "core"."stock_balances" USING btree ("tenant_id","item_id","warehouse_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_batches_tenant_item_batch_unique" ON "core"."stock_batches" USING btree ("tenant_id","item_id","batch_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_batches_tenant_item_expiry_idx" ON "core"."stock_batches" USING btree ("tenant_id","item_id","expiry_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_movements_tenant_operation_unique" ON "core"."stock_movements" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_tenant_item_warehouse_date_idx" ON "core"."stock_movements" USING btree ("tenant_id","item_id","warehouse_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_tenant_reference_idx" ON "core"."stock_movements" USING btree ("tenant_id","reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_serials_tenant_item_serial_unique" ON "core"."stock_serials" USING btree ("tenant_id","item_id","serial_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouses_tenant_code_unique" ON "core"."warehouses" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouses_tenant_branch_idx" ON "core"."warehouses" USING btree ("tenant_id","branch_id");