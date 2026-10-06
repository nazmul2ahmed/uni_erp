CREATE TABLE IF NOT EXISTS "control"."platform_operators" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "control"."platform_operators" ADD CONSTRAINT "platform_operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "control"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
