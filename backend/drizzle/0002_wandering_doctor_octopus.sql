CREATE TABLE "friend_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "friend_messages" ADD CONSTRAINT "friend_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_messages" ADD CONSTRAINT "friend_messages_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friend_messages_pair_idx" ON "friend_messages" USING btree ("sender_id","recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "friend_messages_recipient_idx" ON "friend_messages" USING btree ("recipient_id","created_at");