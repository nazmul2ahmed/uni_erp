CREATE TABLE IF NOT EXISTS "core"."expense_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"reversal_journal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."expense_reversals" ADD CONSTRAINT "expense_reversals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."expense_reversals" ADD CONSTRAINT "expense_reversals_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "core"."expenses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."expense_reversals" ADD CONSTRAINT "expense_reversals_reversal_journal_id_journals_id_fk" FOREIGN KEY ("reversal_journal_id") REFERENCES "core"."journals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."expense_reversals" ADD CONSTRAINT "expense_reversals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "expense_reversals_tenant_expense_unique" ON "core"."expense_reversals" USING btree ("tenant_id","expense_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "expense_reversals_tenant_operation_unique" ON "core"."expense_reversals" USING btree ("tenant_id","operation_id");