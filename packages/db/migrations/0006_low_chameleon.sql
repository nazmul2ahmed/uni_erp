CREATE SCHEMA "modules";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "modules"."rep_custody_balances" (
	"tenant_id" uuid NOT NULL,
	"rep_membership_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity_on_hand" numeric(18, 4) DEFAULT '0' NOT NULL,
	"quantity_pending_return" numeric(18, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "modules"."rep_stock_assignment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity_issued" numeric(18, 4) NOT NULL,
	"quantity_sold" numeric(18, 4) DEFAULT '0' NOT NULL,
	"quantity_returned_good" numeric(18, 4) DEFAULT '0' NOT NULL,
	"quantity_returned_damaged" numeric(18, 4) DEFAULT '0' NOT NULL,
	"quantity_returned_expired" numeric(18, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "modules"."rep_stock_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"rep_membership_id" uuid NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expected_return_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"expected_cash_collected" numeric(18, 4) DEFAULT '0' NOT NULL,
	"cash_remitted" numeric(18, 4),
	"cash_variance" numeric(18, 4),
	"variance_acknowledged_by" uuid,
	"variance_note" text,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "modules"."rep_stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"movement_type" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"reference_type" text,
	"reference_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."receivables" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."receivables" ALTER COLUMN "sale_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."receivables" ADD COLUMN "party_type" text DEFAULT 'CUSTOMER' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."receivables" ADD COLUMN "rep_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."return_lines" ADD COLUMN "condition" text DEFAULT 'RESELLABLE' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_custody_balances" ADD CONSTRAINT "rep_custody_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_custody_balances" ADD CONSTRAINT "rep_custody_balances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_custody_balances" ADD CONSTRAINT "rep_custody_balances_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."stock_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_assignment_lines" ADD CONSTRAINT "rep_stock_assignment_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_assignment_lines" ADD CONSTRAINT "rep_stock_assignment_lines_assignment_id_rep_stock_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "modules"."rep_stock_assignments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_assignment_lines" ADD CONSTRAINT "rep_stock_assignment_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_assignment_lines" ADD CONSTRAINT "rep_stock_assignment_lines_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."stock_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_assignments" ADD CONSTRAINT "rep_stock_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_assignments" ADD CONSTRAINT "rep_stock_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_assignments" ADD CONSTRAINT "rep_stock_assignments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "core"."warehouses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_movements" ADD CONSTRAINT "rep_stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_movements" ADD CONSTRAINT "rep_stock_movements_assignment_id_rep_stock_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "modules"."rep_stock_assignments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_movements" ADD CONSTRAINT "rep_stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "core"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "modules"."rep_stock_movements" ADD CONSTRAINT "rep_stock_movements_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "core"."stock_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rep_custody_balances_tenant_rep_item_idx" ON "modules"."rep_custody_balances" USING btree ("tenant_id","rep_membership_id","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rep_stock_assignment_lines_tenant_assignment_idx" ON "modules"."rep_stock_assignment_lines" USING btree ("tenant_id","assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rep_stock_assignments_tenant_operation_unique" ON "modules"."rep_stock_assignments" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rep_stock_assignments_tenant_rep_idx" ON "modules"."rep_stock_assignments" USING btree ("tenant_id","rep_membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rep_stock_assignments_tenant_status_idx" ON "modules"."rep_stock_assignments" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rep_stock_movements_tenant_operation_unique" ON "modules"."rep_stock_movements" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rep_stock_movements_tenant_assignment_idx" ON "modules"."rep_stock_movements" USING btree ("tenant_id","assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receivables_tenant_rep_idx" ON "core"."receivables" USING btree ("tenant_id","rep_membership_id");