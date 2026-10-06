CREATE TABLE IF NOT EXISTS "core"."return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"sale_item_id" uuid,
	"purchase_item_id" uuid,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"line_total" numeric(18, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"sale_id" uuid,
	"purchase_id" uuid,
	"party_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"status" text DEFAULT 'COMPLETED' NOT NULL,
	"subtotal" numeric(18, 4) NOT NULL,
	"grand_total" numeric(18, 4) NOT NULL,
	"return_date" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity_delta" numeric(18, 4) NOT NULL,
	"previous_quantity" numeric(18, 4) NOT NULL,
	"resulting_quantity" numeric(18, 4) NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."return_lines" ADD CONSTRAINT "return_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."return_lines" ADD CONSTRAINT "return_lines_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "core"."returns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."return_lines" ADD CONSTRAINT "return_lines_sale_item_id_sale_items_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "core"."sale_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."return_lines" ADD CONSTRAINT "return_lines_purchase_item_id_purchase_items_id_fk" FOREIGN KEY ("purchase_item_id") REFERENCES "core"."purchase_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."return_lines" ADD CONSTRAINT "return_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."return_lines" ADD CONSTRAINT "return_lines_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "core"."warehouses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."return_lines" ADD CONSTRAINT "return_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."stock_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."returns" ADD CONSTRAINT "returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."returns" ADD CONSTRAINT "returns_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "core"."sales"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."returns" ADD CONSTRAINT "returns_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "core"."purchases"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."returns" ADD CONSTRAINT "returns_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "core"."warehouses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."returns" ADD CONSTRAINT "returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_adjustments" ADD CONSTRAINT "stock_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_adjustments" ADD CONSTRAINT "stock_adjustments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_adjustments" ADD CONSTRAINT "stock_adjustments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "core"."warehouses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_adjustments" ADD CONSTRAINT "stock_adjustments_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."stock_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_lines_tenant_return_idx" ON "core"."return_lines" USING btree ("tenant_id","return_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "returns_tenant_operation_unique" ON "core"."returns" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "returns_tenant_date_idx" ON "core"."returns" USING btree ("tenant_id","return_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "returns_tenant_sale_idx" ON "core"."returns" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "returns_tenant_purchase_idx" ON "core"."returns" USING btree ("tenant_id","purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_adjustments_tenant_operation_unique" ON "core"."stock_adjustments" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_adjustments_tenant_date_idx" ON "core"."stock_adjustments" USING btree ("tenant_id","created_at");