CREATE TABLE "cosmetics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"rarity" text,
	"artist" text,
	"price_soft" integer,
	"price_hard" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_config" (
	"id" text PRIMARY KEY NOT NULL,
	"rotation_hours" integer DEFAULT 6 NOT NULL,
	"items_per_rotation" integer DEFAULT 4 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"cosmetic_id" uuid,
	"flare" text NOT NULL,
	"currency_type" text NOT NULL,
	"price_paid" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_rotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"cosmetic_ids" uuid[] NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "currency_soft" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "currency_hard" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_purchases" ADD CONSTRAINT "shop_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_purchases" ADD CONSTRAINT "shop_purchases_cosmetic_id_cosmetics_id_fk" FOREIGN KEY ("cosmetic_id") REFERENCES "public"."cosmetics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cosmetics_kind_name" ON "cosmetics" USING btree ("kind","name");--> statement-breakpoint
CREATE INDEX "cosmetics_published_idx" ON "cosmetics" USING btree ("published");--> statement-breakpoint
CREATE INDEX "shop_purchases_user_idx" ON "shop_purchases" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "shop_rotations_window_idx" ON "shop_rotations" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_rotations_starts_at" ON "shop_rotations" USING btree ("starts_at");