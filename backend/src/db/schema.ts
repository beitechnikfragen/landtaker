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
    // Soft currency for the store-to-be. Earned/spent nowhere yet; the
    // column exists so the balance has a home before the first sink does.
    credits: integer("credits").notNull().default(0),
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
// Feedback
// ---------------------------------------------------------------------------

/**
 * In-game bug reports, ideas and other feedback.
 *
 * Submitted by guests as well as logged-in players (a bug that prevents login
 * must still be reportable), which is why `userId` is nullable and why the
 * route in front of this is gated by Turnstile and a rate limit.
 *
 * Rows are written by players and read by admins. Nothing here is ever sent
 * back to another player, so the only consumer of the shape is our own future
 * admin area.
 */
export const feedbackReports = pgTable(
  "feedback_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Null for guests. ON DELETE SET NULL rather than CASCADE: if an account
    // goes away the report is still a valid bug report, it just loses its
    // author. Deleting real feedback because someone closed their account
    // would lose information we cannot recover.
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // 'bug' | 'idea' | 'other'. Text, not a pg enum, so the admin area can
    // grow a category without a migration. Zod validates at the boundary.
    type: text("type").notNull(),

    // 'new' | 'triaged' | 'resolved' | 'rejected'. Same reasoning; the real
    // triage vocabulary will only be known once the admin area is built.
    status: text("status").notNull().default("new"),

    message: text("message").notNull(),

    // Guests only, optional — their sole route to a reply. Logged-in users
    // have a contactable account already, so the route drops this for them.
    contactEmail: text("contact_email"),

    // Client version, user agent, screen size and similar. jsonb because the
    // diagnostic shape will change and a column per field means a migration
    // every time. Only ever read by a human.
    context: jsonb("context"),

    // Truncated to a /24 (IPv4) or /48 (IPv6) prefix — see truncateIp() in
    // services/feedback.ts. Enough to correlate an abuse pattern, without
    // this table becoming a years-long log of identifying addresses.
    submitterIp: text("submitter_ip"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // NOT maintained by a trigger. The admin area sets it when it changes
    // status; until then it equals createdAt.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The admin area's default view: unhandled reports, newest first.
    index("feedback_reports_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    // "Everything this user reported" — for spotting a serial reporter.
    index("feedback_reports_user_idx").on(table.userId),
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
