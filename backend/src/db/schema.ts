import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Schema shaped by the contracts the game already expects — chiefly
 * `UserMeResponseSchema` in src/core/ApiSchemas.ts. Where a column exists only
 * to satisfy that response, the comment says so, because those cannot be
 * renamed freely.
 */

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * `id` is what the game calls the persistent ID: it lands in the JWT `sub`
 * claim (base64url-encoded) and is parsed back to a UUID by TokenPayloadSchema.
 * `publicId` is the only identifier ever shown to other players.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull().unique(),

    email: text("email"),

    // Roles the game recognises: root | admin | mod | flagged | banned.
    // Null means an ordinary player; the claim is then omitted from the token.
    role: text("role"),

    // Display name split into base + 4-digit discriminator. The game requires
    // the discriminator to stay a string (leading zeros are significant) and
    // forbids assembling the display form client-side.
    usernameBase: text("username_base"),
    usernameDiscriminator: text("username_discriminator"),
    usernameStatus: text("username_status"),
    usernameClaimExpiresAt: timestamp("username_claim_expires_at", {
      withTimezone: true,
    }),
    nextUsernameChangeAt: timestamp("next_username_change_at", {
      withTimezone: true,
    }),

    adfree: boolean("adfree").notNull().default(false),
    unlimitedRanked: boolean("unlimited_ranked").notNull().default(false),
    // Legacy balance, predating the two-currency split below. Kept because
    // UserMeResponseSchema still carries `credits` and the admin panel edits
    // it; the shop spends currencySoft/currencyHard.
    credits: integer("credits").notNull().default(0),
    // Shop wallet. Two currencies because UserMeResponseSchema's
    // CurrencyBalancesSchema requires both: soft is earned, hard is bought.
    currencySoft: integer("currency_soft").notNull().default(0),
    currencyHard: integer("currency_hard").notNull().default(0),
    canCreatePublicLobbies: boolean("can_create_public_lobbies")
      .notNull()
      .default(false),

    flares: text("flares").array(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [
    // Two players may share a base name but never the same base+discriminator.
    uniqueIndex("users_username_unique")
      .on(table.usernameBase, table.usernameDiscriminator)
      .where(sql`${table.usernameBase} is not null`),
  ],
);

/**
 * External identities (discord, google, steam). One row per provider per user,
 * so linking a second provider never rewrites the first.
 */
export const identities = pgTable(
  "identities",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // discord | google | steam
    providerUserId: text("provider_user_id").notNull(),
    // Provider payload as returned to /users/@me (avatar, username, ...).
    profile: jsonb("profile").notNull().default({}),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerUserId] }),
    index("identities_user_idx").on(table.userId),
  ],
);

/**
 * Bans surfaced to the banned player. A null `expiresAt` is permanent; the
 * game localizes `category` client-side and tolerates unknown values.
 */
export const bans = pgTable(
  "bans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
  },
  (table) => [index("bans_active_idx").on(table.userId, table.liftedAt)],
);

/**
 * Refresh tokens are stored hashed — a database leak must not hand out live
 * sessions. Rotated on every use; `replacedBy` makes reuse of an old token
 * detectable (a signal the token was stolen).
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedBy: uuid("replaced_by"),
  },
  (table) => [index("refresh_tokens_user_idx").on(table.userId)],
);

/**
 * Single-use sign-in tokens delivered by email (magic links).
 *
 * Hashed like refresh tokens: the plaintext only ever exists in the email, so
 * a database leak cannot be replayed into a session. `consumedAt` enforces
 * one-time use — a link forwarded, logged by a mail scanner, or left in an
 * inbox must not sign anyone in twice.
 *
 * `email` is stored alongside the user because the address may be new to the
 * account: signing in this way is also how an email gets attached.
 */
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [index("login_tokens_user_idx").on(table.userId)],
);

/**
 * Every mutation made through the admin panel, append-only.
 *
 * The panel can change roles, move credits and issue bans, so "who did this
 * and when" has to be answerable after the fact — both to review an admin and
 * to reconstruct an account's history when a player disputes it.
 *
 * `actorId` is `set null` rather than cascade: deleting an admin account must
 * not erase the record of what it did. `detail` holds the action-specific
 * payload (before/after values, reasons) as JSON because the shape differs per
 * action and a column per variant would be mostly nulls.
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Denormalised so the log still names the actor after the account is gone.
    actorName: text("actor_name"),
    action: text("action").notNull(),
    // Free-form rather than a foreign key: later actions target cosmetics and
    // shop rotations, not only users.
    targetId: text("target_id"),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The log is read newest-first, either whole or filtered to one target.
    index("admin_audit_created_idx").on(table.createdAt),
    index("admin_audit_target_idx").on(table.targetId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

/**
 * The cosmetics catalog served at GET /cosmetics.json.
 *
 * One row per item across every kind (pattern, flag, crown, skin, effect),
 * discriminated by `kind`, because the game's CosmeticsSchema nests them under
 * separate keys but they are otherwise the same shape: a name, a price, and a
 * kind-specific payload. A table per kind would duplicate the price and
 * rotation columns five times.
 *
 * `payload` holds the kind-specific part verbatim (a pattern's encoded data, a
 * flag's URL, an effect's attributes) so adding a field to one kind needs no
 * migration. It is validated against the game's own schema when the catalog is
 * assembled, not here.
 */
export const cosmetics = pgTable(
  "cosmetics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // pattern | flag | crown | skin | effect
    kind: text("kind").notNull(),
    // The catalog key AND the flare suffix ("flag:<name>"), so it must be
    // stable — renaming an item revokes it from everyone who owns it.
    name: text("name").notNull(),
    displayName: text("display_name"),
    rarity: text("rarity"),
    artist: text("artist"),
    // Null price = not purchasable with that currency. An item with both null
    // is display-only (granted by admin or bundled).
    priceSoft: integer("price_soft"),
    priceHard: integer("price_hard"),
    // Kind-specific fields (pattern data, url, effect attributes, effectType).
    payload: jsonb("payload").notNull().default({}),
    // Hidden items never reach /cosmetics.json — the staging state for an item
    // being prepared for a future drop.
    published: boolean("published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A flare names an item by kind+name, so that pair has to be unique or
    // ownership becomes ambiguous.
    uniqueIndex("cosmetics_kind_name").on(table.kind, table.name),
    index("cosmetics_published_idx").on(table.published),
  ],
);

/**
 * A rotating drop window: which items are for sale, and until when.
 *
 * Rows are created ahead of time by the rotation engine rather than computed
 * on read. Two reasons: a player who loads the shop as a window closes must
 * not see a different lineup than the purchase endpoint enforces, and the
 * admin panel needs to preview and edit an upcoming drop before it goes live.
 */
export const shopRotations = pgTable(
  "shop_rotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // Cosmetic ids in this window. Denormalised into an array rather than a
    // join table: the list is read whole on every shop load, never queried by
    // member, and is small (a handful of items).
    cosmeticIds: uuid("cosmetic_ids").array().notNull(),
    // Set when an admin edited the lineup, so the engine leaves it alone
    // instead of regenerating over a deliberate choice.
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // "Which window is live now" and "what is next" are the only two queries.
    index("shop_rotations_window_idx").on(table.startsAt, table.endsAt),
    // One lineup per window. Rotations are created on demand by whichever
    // request first crosses a boundary, so two concurrent requests would
    // otherwise insert two different lineups for the same window and players
    // would see different drops depending on which row was read.
    uniqueIndex("shop_rotations_starts_at").on(table.startsAt),
  ],
);

/**
 * Shop configuration. A single row (id = "default") rather than a settings
 * file, so the admin panel can change the drop cadence without a redeploy.
 */
export const shopConfig = pgTable("shop_config", {
  id: text("id").primaryKey(),
  // How often a new drop replaces the last. Hours because that is how the
  // feature is described ("every X hours") and it avoids cron syntax.
  rotationHours: integer("rotation_hours").notNull().default(6),
  // How many items each drop contains.
  itemsPerRotation: integer("items_per_rotation").notNull().default(4),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Purchase ledger, append-only.
 *
 * Entitlement itself lives in users.flares (that is what the game reads), so
 * this exists to answer "what did they pay, and when" — for refunds, for
 * disputes, and so a price change never rewrites history. `pricePaid` and
 * `currencyType` are recorded rather than joined to the catalog for the same
 * reason.
 */
export const shopPurchases = pgTable(
  "shop_purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cosmeticId: uuid("cosmetic_id").references(() => cosmetics.id, {
      onDelete: "set null",
    }),
    // Kept even if the cosmetic row is deleted — the flare granted survives it.
    flare: text("flare").notNull(),
    currencyType: text("currency_type").notNull(), // soft | hard
    pricePaid: integer("price_paid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("shop_purchases_user_idx").on(table.userId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Social
// ---------------------------------------------------------------------------

/**
 * Friendships are stored once, not twice, with `userIdA < userIdB` enforced by
 * a check constraint. Halves the rows and makes "are these two friends?" a
 * single lookup instead of a pair that can disagree.
 */
export const friendships = pgTable(
  "friendships",
  {
    userIdA: uuid("user_id_a")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userIdB: uuid("user_id_b")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userIdA, table.userIdB] }),
    index("friendships_b_idx").on(table.userIdB),
  ],
);

export const friendRequests = pgTable(
  "friend_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("friend_requests_pair").on(table.fromUserId, table.toUserId),
    index("friend_requests_to_idx").on(table.toUserId),
  ],
);

/**
 * Direct messages between friends. Sender/recipient are stored as-is (not as
 * an ordered pair like friendships): a message HAS a direction, and the
 * conversation view needs it. History survives an unfriend — the rows only
 * disappear when an account does (cascade).
 */
export const friendMessages = pgTable(
  "friend_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The conversation query looks both ways; one index per direction keeps
    // it an index scan whichever side the caller is on.
    index("friend_messages_pair_idx").on(
      table.senderId,
      table.recipientId,
      table.createdAt,
    ),
    index("friend_messages_recipient_idx").on(
      table.recipientId,
      table.createdAt,
    ),
  ],
);

/**
 * Parties: the new feature. Only membership and settings live here — who is
 * currently online and which lobby the party is watching is ephemeral and
 * belongs in Redis. Persisting a party lets it survive a backend restart.
 */
export const parties = pgTable("parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  leaderId: uuid("leader_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Short human-shareable code, e.g. "K3F9QW".
  inviteCode: text("invite_code").notNull().unique(),
  // Open parties can be joined with only the code; closed ones need an invite.
  isOpen: boolean("is_open").notNull().default(false),
  maxMembers: integer("max_members").notNull().default(4),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const partyMembers = pgTable(
  "party_members",
  {
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.partyId, table.userId] }),
    // A player is in at most one party at a time.
    uniqueIndex("party_members_user_unique").on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// Games and ranking
// ---------------------------------------------------------------------------

/**
 * Game archive. The game server POSTs a full record to /game/{id} when a match
 * ends; the record is kept verbatim in `record` so replays stay byte-exact,
 * with the queried fields promoted to columns.
 *
 * `gitCommit` matters: a replay is only valid on the commit it was recorded on,
 * because the simulation is deterministic per-version.
 */
export const games = pgTable(
  "games",
  {
    id: text("id").primaryKey(),
    gitCommit: text("git_commit"),
    domain: text("domain"),
    subdomain: text("subdomain"),
    mode: text("mode"),
    map: text("map"),
    rankedType: text("ranked_type"),
    // Record schema version ("v0.0.2"). Promoted so a future migration can find
    // the records written under an older shape without opening every blob.
    version: text("version"),
    // Winner as recorded: ["player", clientID, ...] | ["team", name, ...].
    // Stored whole because its first element decides how to read the rest.
    winner: jsonb("winner"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Seconds of play, straight from the record — avoids ended-started
    // subtraction at query time and stays correct if either bound is null.
    durationSeconds: integer("duration_seconds"),
    turnCount: integer("turn_count"),
    record: jsonb("record").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("games_ended_idx").on(table.endedAt)],
);

/**
 * Per-player match results. Split from `games` so leaderboards and player
 * history never scan the archived JSON blobs.
 *
 * Keyed by (gameId, clientID), not (gameId, playerName): nothing stops two
 * players in one lobby from picking the same username — UsernameSchema has no
 * uniqueness rule and `anonymizeNames` games actively produce collisions — so
 * a name-keyed table would silently drop players. `clientID` is assigned by the
 * game server and is unique within a game.
 */
export const gameParticipants = pgTable(
  "game_participants",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    // Per-game player handle from the record (PlayerRecord.clientID).
    clientId: text("client_id").notNull(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Kept even when userId is null (guest players).
    playerName: text("player_name"),
    clanTag: text("clan_tag"),
    team: text("team"),
    placement: integer("placement"),
    won: boolean("won"),
    stats: jsonb("stats"),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.clientId] }),
    index("game_participants_user_idx").on(table.userId),
    // Player history: "every game this account played", newest first.
    index("game_participants_name_idx").on(table.playerName),
  ],
);

/**
 * ELO per ranked mode ("1v1" | "2v2"), one row per user per mode.
 */
export const leaderboardEntries = pgTable(
  "leaderboard_entries",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    elo: integer("elo").notNull().default(1000),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.mode] }),
    // Serves the leaderboard read path directly.
    index("leaderboard_rank_idx").on(table.mode, table.elo),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  identities: many(identities),
  bans: many(bans),
  leaderboardEntries: many(leaderboardEntries),
  gameParticipations: many(gameParticipants),
}));

export const identitiesRelations = relations(identities, ({ one }) => ({
  user: one(users, {
    fields: [identities.userId],
    references: [users.id],
  }),
}));

export const partiesRelations = relations(parties, ({ one, many }) => ({
  leader: one(users, {
    fields: [parties.leaderId],
    references: [users.id],
  }),
  members: many(partyMembers),
}));

export const partyMembersRelations = relations(partyMembers, ({ one }) => ({
  party: one(parties, {
    fields: [partyMembers.partyId],
    references: [parties.id],
  }),
  user: one(users, {
    fields: [partyMembers.userId],
    references: [users.id],
  }),
}));

export const gamesRelations = relations(games, ({ many }) => ({
  participants: many(gameParticipants),
}));

export const gameParticipantsRelations = relations(
  gameParticipants,
  ({ one }) => ({
    game: one(games, {
      fields: [gameParticipants.gameId],
      references: [games.id],
    }),
    user: one(users, {
      fields: [gameParticipants.userId],
      references: [users.id],
    }),
  }),
);
