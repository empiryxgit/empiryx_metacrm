CREATE TABLE IF NOT EXISTS "crm"."branch_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"manager_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "crm"."campaigns" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."form_submissions" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."forms" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."branch_users" ADD CONSTRAINT "branch_users_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "crm"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."branch_users" ADD CONSTRAINT "branch_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."branches" ADD CONSTRAINT "branches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."branches" ADD CONSTRAINT "branches_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_branch_users_branch_id" ON "crm"."branch_users" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_branch_users_user_id" ON "crm"."branch_users" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_branch_users_branch_user" ON "crm"."branch_users" USING btree ("branch_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_branch_users_one_primary_per_user" ON "crm"."branch_users" USING btree ("user_id") WHERE is_primary = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_branches_company_id" ON "crm"."branches" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_branches_company_code" ON "crm"."branches" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_branches_manager_id" ON "crm"."branches" USING btree ("manager_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."campaigns" ADD CONSTRAINT "campaigns_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "crm"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."form_submissions" ADD CONSTRAINT "form_submissions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "crm"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."forms" ADD CONSTRAINT "forms_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "crm"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."leads" ADD CONSTRAINT "leads_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "crm"."branches"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_campaigns_branch_id" ON "crm"."campaigns" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_form_submissions_branch_id" ON "crm"."form_submissions" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_forms_branch_id" ON "crm"."forms" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_branch_id" ON "crm"."leads" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_company_id_branch_id" ON "crm"."leads" USING btree ("company_id","branch_id");