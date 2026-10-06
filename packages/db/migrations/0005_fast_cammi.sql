CREATE TABLE IF NOT EXISTS "control"."tenant_features" (
	"tenant_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'OVERRIDE' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "tenant_features_tenant_id_feature_key_pk" PRIMARY KEY("tenant_id","feature_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "control"."tenant_features" ADD CONSTRAINT "tenant_features_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "control"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "control"."tenant_features" ADD CONSTRAINT "tenant_features_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
