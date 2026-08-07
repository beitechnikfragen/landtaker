--> Re-keys game_participants from (game_id, player_name) to (game_id, client_id).
--> Two players in one lobby may share a username, so a name-keyed table
--> silently dropped participants. clientID is unique within a game.
--> drizzle-kit emitted the ADD CONSTRAINT before the ADD COLUMN it references;
--> the statements are reordered here so the migration actually applies.
ALTER TABLE "game_participants" DROP CONSTRAINT "game_participants_game_id_player_name_pk";--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "client_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_game_id_client_id_pk" PRIMARY KEY("game_id","client_id");--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "clan_tag" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "winner" jsonb;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "turn_count" integer;--> statement-breakpoint
CREATE INDEX "game_participants_name_idx" ON "game_participants" USING btree ("player_name");
