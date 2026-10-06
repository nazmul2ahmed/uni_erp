ALTER TABLE "core"."purchase_items" DROP CONSTRAINT "purchase_items_tax_profile_id_tax_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."sale_items" DROP CONSTRAINT "sale_items_tax_profile_id_tax_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."items" DROP CONSTRAINT "items_tax_profile_id_tax_profiles_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."purchase_items" ADD CONSTRAINT "purchase_items_tax_profile_id_tax_profiles_id_fk" FOREIGN KEY ("tax_profile_id") REFERENCES "core"."tax_profiles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."sale_items" ADD CONSTRAINT "sale_items_tax_profile_id_tax_profiles_id_fk" FOREIGN KEY ("tax_profile_id") REFERENCES "core"."tax_profiles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core"."items" ADD CONSTRAINT "items_tax_profile_id_tax_profiles_id_fk" FOREIGN KEY ("tax_profile_id") REFERENCES "core"."tax_profiles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
