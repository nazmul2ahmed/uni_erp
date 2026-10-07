CREATE TABLE IF NOT EXISTS "core"."accounting_period_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"action" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'CLOSED' NOT NULL,
	"closing_journal_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core"."opening_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"customer_id" uuid,
	"supplier_id" uuid,
	"account_code" text,
	"amount" numeric(18, 4) NOT NULL,
	"paid_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"balance" numeric(18, 4) NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"due_date" date,
	"journal_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."accounting_period_events" ADD CONSTRAINT "accounting_period_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."accounting_period_events" ADD CONSTRAINT "accounting_period_events_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "core"."accounting_periods"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."accounting_period_events" ADD CONSTRAINT "accounting_period_events_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "core"."journals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."accounting_period_events" ADD CONSTRAINT "accounting_period_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."accounting_periods" ADD CONSTRAINT "accounting_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."accounting_periods" ADD CONSTRAINT "accounting_periods_closing_journal_id_journals_id_fk" FOREIGN KEY ("closing_journal_id") REFERENCES "core"."journals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."opening_balances" ADD CONSTRAINT "opening_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."opening_balances" ADD CONSTRAINT "opening_balances_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "core"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."opening_balances" ADD CONSTRAINT "opening_balances_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "core"."suppliers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."opening_balances" ADD CONSTRAINT "opening_balances_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "core"."journals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."opening_balances" ADD CONSTRAINT "opening_balances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_period_events_tenant_operation_unique" ON "core"."accounting_period_events" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_period_events_tenant_period_idx" ON "core"."accounting_period_events" USING btree ("tenant_id","period_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounting_periods_tenant_range_unique" ON "core"."accounting_periods" USING btree ("tenant_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_periods_tenant_end_idx" ON "core"."accounting_periods" USING btree ("tenant_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opening_balances_tenant_type_reference_unique" ON "core"."opening_balances" USING btree ("tenant_id","entry_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "opening_balances_tenant_operation_unique" ON "core"."opening_balances" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opening_balances_tenant_customer_idx" ON "core"."opening_balances" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opening_balances_tenant_supplier_idx" ON "core"."opening_balances" USING btree ("tenant_id","supplier_id");