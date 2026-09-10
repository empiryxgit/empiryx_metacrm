DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "extra_campaign_slots" integer DEFAULT 0 NOT NULL;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "extra_client_slots" integer DEFAULT 0 NOT NULL;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "extra_capacity_cycle" text;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "extra_capacity_expires_at" timestamp with time zone;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."billing_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"cycle" text NOT NULL,
	"amount_in_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"razorpay_order_id" text NOT NULL,
	"razorpay_payment_id" text,
	"razorpay_signature" text,
	"status" text DEFAULT 'created' NOT NULL,
	"verified_at" timestamp with time zone,
	"webhook_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."billing_orders" ADD CONSTRAINT "billing_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."billing_orders" ADD CONSTRAINT "billing_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_billing_orders_company_id" ON "crm"."billing_orders" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_billing_orders_razorpay_order_id" ON "crm"."billing_orders" USING btree ("razorpay_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_billing_orders_status" ON "crm"."billing_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_billing_orders_created_at" ON "crm"."billing_orders" USING btree ("created_at");
