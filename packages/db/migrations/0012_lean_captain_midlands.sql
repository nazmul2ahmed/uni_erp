CREATE TABLE IF NOT EXISTS "core"."tax_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(9, 4) NOT NULL,
	"is_inclusive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."purchase_items" ADD COLUMN "tax_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."purchase_items" ADD COLUMN "tax_rate" numeric(9, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."sale_items" ADD COLUMN "tax_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."sale_items" ADD COLUMN "tax_rate" numeric(9, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."tax_profiles" ADD CONSTRAINT "tax_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchase_items" ADD CONSTRAINT "purchase_items_tax_profile_id_tax_profiles_id_fk" FOREIGN KEY ("tax_profile_id") REFERENCES "core"."tax_profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sale_items" ADD CONSTRAINT "sale_items_tax_profile_id_tax_profiles_id_fk" FOREIGN KEY ("tax_profile_id") REFERENCES "core"."tax_profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."items" ADD CONSTRAINT "items_tax_profile_id_tax_profiles_id_fk" FOREIGN KEY ("tax_profile_id") REFERENCES "core"."tax_profiles"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
