import type { Tribe } from "@game/Schemas.ts";

/**
 * Custom tribe names — the pool of PURCHASED bot names for one game.
 *
 * WHAT THIS BACKEND CAN TRUTHFULLY SERVE TODAY: nothing but an empty pool.
 *
 * A tribe name is a piece of paid, moderated user-generated content. For a
 * name to legitimately appear in this response, all of the following must have
 * happened, and none of them exist here:
 *
 *   1. A player BOUGHT it with hard currency. There is no hard-currency
 *      balance in this backend and no Stripe integration (see the 501s in
 *      routes/stubs.ts), so nothing has ever been bought.
 *   2. It was RECORDED against its owner. There is no table for tribe names —
 *      schema.ts has users/identities/bans/refreshTokens/friendships/
 *      friendRequests/parties/partyMembers/games/gameParticipants/
 *      leaderboardEntries and nothing else.
 *   3. It carries a MODERATION STATE. TribeNameStatusSchema
 *      (src/core/ApiSchemas.ts) defines `pending` (bought, not yet reviewed)
 *      and `live` (reviewed, kept) as the two states in rotation, versus
 *      `rejected`/`revoked` which are taken down. There is no moderation
 *      pipeline, no mod tooling and no reviewer, so no name could be moved
 *      between those states.
 *
 * So the honest answer is `{ tribes: [] }` — "no purchased names exist", which
 * is TRUE, not a placeholder for a truth we are hiding.
 *
 * WHY NOT SYNTHESIZE NAMES. It would be trivially easy to fill this array from
 * resources/tribeNameThemes.json and make the feature "work". That would be a
 * lie in three separate directions, and each one causes real damage:
 *
 *   - Ownership. The response feeds GameStartInfo.tribes, which rides the
 *     analytics record to infra at game end for OWNER APPEARANCE STATS (see
 *     the comment on GameStartInfoSchema in src/core/Schemas.ts) and drives
 *     the public tribe leaderboard's `gamesAppeared`/`playerReach`
 *     (TribeLeaderboardEntrySchema). Invented names would manufacture
 *     appearance statistics for purchases nobody made.
 *   - Moderation. Every name here is meant to have passed through a review
 *     queue. Names that never entered one are unreviewed UGC being presented
 *     as reviewed UGC.
 *   - Redundancy. It would not even add anything. When this returns an empty
 *     pool the game falls back to ORGANIC bot names, which the deterministic
 *     core already generates from tribeNameThemes.json itself
 *     (src/core/execution/utils/TribeNames.ts). Serving those same themes over
 *     HTTP would relabel locally-generated names as purchased ones — strictly
 *     worse than returning nothing, and identical in what the player sees.
 *
 * WHAT WOULD BE NEEDED TO MAKE THIS REAL (schema.ts is owned elsewhere — this
 * is a specification, not a change):
 *
 *   custom_tribe_names
 *     id            bigserial primary key   -- serialized as a STRING on the
 *                                              wire (TribeNameSchema.id), so
 *                                              bigint is safe
 *     owner_id      uuid not null references users(id) on delete cascade
 *     display_name  text not null           -- must satisfy SafeString.min(1)
 *                                              .max(64) (TribeSchema), since
 *                                              the game re-validates it
 *     status        text not null           -- 'pending'|'live'|'rejected'
 *                                              |'revoked'
 *     review_reason text                    -- non-null only when rejected or
 *                                              revoked (TribeNameSchema)
 *     price_paid    bigint not null         -- audit trail for the purchase
 *     created_at / reviewed_at  timestamptz
 *     UNIQUE on lower(display_name) WHERE status IN ('pending','live')
 *       -- active names are globally unique, which is precisely why
 *          TribeSchema can identify a tribe by its name alone.
 *
 *   custom_tribe_boosts
 *     id                    bigserial primary key
 *     custom_tribe_name_id  bigint not null references custom_tribe_names(id)
 *     expires_at            timestamptz not null   -- "unexpired" = the
 *                                                     activeBoosts predicate
 *     price_paid            bigint not null
 *
 * Plus, outside the schema: a hard-currency ledger to debit, and a moderation
 * queue with an actual human able to move a name to rejected/revoked. Without
 * that last piece the table would only ever hold `pending` rows, which means
 * shipping unreviewed paid UGC into live games — the reason this returns empty
 * rather than being half-built.
 */

/** A logged-in human in the lobby. Mirrors TribePoolPlayer in
 * src/server/CustomTribes.ts: guests are omitted by the game before it calls
 * us, because guests cannot own tribe names. */
export interface TribePoolPlayer {
  clientId: string;
  publicId: string;
}

/**
 * The game slices the array by position: up to 10 names owned by players in
 * this lobby first, then up to 10 from the global pool, and it drops from the
 * TAIL when there are fewer bots than names (GameServer.fetchTribes). So order
 * is load-bearing and any real implementation must emit owned-first.
 *
 * Exported so the ordering contract is stated once and asserted in tests,
 * rather than becoming folklore once someone implements the query.
 */
export const MAX_OWNED_TRIBES = 10;
export const MAX_GLOBAL_TRIBES = 10;

/**
 * The game caps the array at 100 (CustomTribesResponseSchema in
 * src/server/CustomTribes.ts uses `.max(100)`) and rejects the WHOLE response
 * if it is longer — which the game logs as malformed and treats exactly like
 * an outage. Our own cap must stay at or under theirs.
 */
export const MAX_TRIBES = 100;

/**
 * Build the tribe pool for one game.
 *
 * Returns an empty pool, always, for the reasons documented at the top of this
 * file. It is deliberately written as a real function over the real input
 * rather than a route-level `return { tribes: [] }`, so that the day the
 * tables above exist there is one obvious place to implement the query and one
 * existing test suite asserting the contract it has to satisfy.
 *
 * Note the game FAILS OPEN: on error or timeout it starts the game with
 * organic bot names. An empty pool produces the identical outcome by the
 * intended path, which is why 200 + `{tribes: []}` is right here and an error
 * status would be wrong — nothing is broken.
 */
export function buildTribePool(_players: TribePoolPlayer[]): Tribe[] {
  // No purchases exist, so no player owns a name and the global pool is empty.
  // When custom_tribe_names lands this becomes two queries, concatenated
  // owned-first:
  //   owned  = names WHERE owner_id IN (publicId -> users.id)
  //              AND status IN ('pending','live')
  //              ORDER BY random() * (1 + activeBoosts) DESC
  //              LIMIT MAX_OWNED_TRIBES
  //   global = the same, minus the owner filter, excluding ids already picked,
  //              LIMIT MAX_GLOBAL_TRIBES
  // The draw weight is 1 + activeBoosts, as documented on
  // TribeNameSchema.activeBoosts in src/core/ApiSchemas.ts.
  return [];
}
