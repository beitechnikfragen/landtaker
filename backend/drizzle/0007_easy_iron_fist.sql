CREATE TABLE "feedback_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"message" text NOT NULL,
	"contact_email" text,
	"context" jsonb,
	"submitter_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_reports_status_created_idx" ON "feedback_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_reports_user_idx" ON "feedback_reports" USING btree ("user_id");