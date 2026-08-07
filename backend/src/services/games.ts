import type { GameRecord } from "@game/Schemas.ts";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { gameParticipants, games, users } from "../db/schema.ts";

/**
 * The game archive. When a match ends the game server POSTs the full
 * GameRecord to /game/{id} (src/server/Archive.ts) and later GETs it back to
 * drive replays.
 *
 * The record is stored verbatim in `games.record`. That is the whole point of
 * the table: a replay re-runs the deterministic simulation over the recorded
 * turns, so the bytes we hand back must be the bytes we were given. Anything
 * we "helpfully" normalise on the way in is a desync on the way out. The
 * queried fields are copied into columns alongside it, and those copies are
 * derived data — the blob stays the source of truth.
 */

/**
 * A record is only replayable on the build that produced it. The simulation is
 * deterministic *per version*: a balance tweak or a change to tick order makes
 * the same intents produce different state, so replaying a record on another
 * commit desyncs against the hashes stored in its turns. The client enforces
 * this itself (JoinLobbyModal.checkArchivedGame rejects a record whose
 * gitCommit differs from its own, unless it is a DEV build) — we store the
 * commit so it has something to compare against, and never rewrite it.
 */

export type ArchiveResult =
  | { ok: true; created: boolean }
  | { ok: false; error: ArchiveError };

export type ArchiveError = "id_mismatch";

/**
 * `record` arrives as the raw parsed JSON body rather than a Zod-parsed
 * GameRecord. That is deliberate: PlayerStatsSchema coerces its numeric fields
 * to `bigint`, so a parsed record cannot be JSON.stringify'd without the
 * game's `replacer`, and round-tripping through it would rewrite the stored
 * bytes. We validate a *copy* and persist the original.
 */
export interface ArchiveInput {
  /** The record exactly as received, for the jsonb column. */
  raw: unknown;
  /** The same record, validated, for deriving the promoted columns. */
  record: GameRecord;
}

/** Milliseconds since the epoch to a Date, tolerating 0 / absent. */
function toDate(ms: number | undefined | null): Date | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms);
}

/**
 * Which clientIDs won. The winner tuple is `["player", clientID, ...]` for FFA
 * and `["team", teamName, ...clientIDs]` for team games — in both cases every
 * element after the first that is a clientID belongs to the winning side, so
 * the team name in slot 1 is skipped by checking against the player set.
 */
function winningClientIds(record: GameRecord): Set<string> {
  const winner = record.info.winner;
  if (!winner) return new Set();
  const known = new Set(record.info.players.map((p) => p.clientID));
  return new Set(winner.slice(1).filter((id) => known.has(id)));
}

/**
 * Team a player was on, or null in FFA. `teamIndex` is the server-stamped slot
 * used for matchmade team games; it is the only team marker the record carries
 * per player.
 */
function teamOf(player: GameRecord["info"]["players"][number]): string | null {
  return player.teamIndex === undefined ? null : String(player.teamIndex);
}

/**
 * Writes the record and its participants in one transaction.
 *
 * Re-POSTing the same game id is an UPSERT, not a 409.
 *
 * The caller is a fire-and-forget `fetch` in the game server with no retry
 * bookkeeping (Archive.ts logs a failure and moves on), and archiveGame() can
 * run more than once for a game — a worker that restarts mid-archive, or a
 * retried delivery, replays the same POST. Under a conflict policy those
 * become permanent 409s in the logs for a write that actually succeeded, and
 * the operator cannot tell a duplicate from a genuine id collision.
 *
 * Upserting is safe here because the id is the game's own id and the payload
 * is server-authored and immutable: the second write carries the same bytes as
 * the first. Where it is not a no-op is the case that matters — a re-archive
 * after a crash finishing a record that was written incompletely.
 *
 * The response still distinguishes the two (201 created / 200 updated) so a
 * duplicate is visible to anyone looking, without failing the call.
 */
export async function archiveGame(
  gameId: string,
  input: ArchiveInput,
): Promise<ArchiveResult> {
  const { raw, record } = input;

  // The URL is authoritative; a record claiming a different id would archive
  // under one key and be looked up under another.
  if (record.info.gameID !== gameId) {
    return { ok: false, error: "id_mismatch" };
  }

  const row = {
    id: gameId,
    gitCommit: record.gitCommit,
    domain: record.domain ?? null,
    subdomain: record.subdomain ?? null,
    mode: record.info.config.gameMode ?? null,
    map: record.info.config.gameMap ?? null,
    rankedType: record.info.config.rankedType ?? null,
    version: record.version,
    winner: record.info.winner ?? null,
    startedAt: toDate(record.info.start),
    endedAt: toDate(record.info.end),
    durationSeconds: record.info.duration,
    turnCount: record.info.num_turns,
    record: raw,
  };

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: games.id })
      .from(games)
      .where(eq(games.id, gameId));
    const created = existing.length === 0;

    await tx
      .insert(games)
      .values(row)
      .onConflictDoUpdate({
        target: games.id,
        set: { ...row, archivedAt: new Date() },
      });

    const participants = await buildParticipants(gameId, record, raw);

    // Replace rather than upsert row-by-row: a re-archive may carry a
    // different player set (a crash mid-write could have persisted only some),
    // and leaving the old rows behind would leave a player in two states.
    await tx
      .delete(gameParticipants)
      .where(eq(gameParticipants.gameId, gameId));
    if (participants.length > 0) {
      await tx.insert(gameParticipants).values(participants);
    }

    return { ok: true, created };
  });
}

/**
 * Per-player stats taken from the *raw* body rather than the parsed record.
 *
 * PlayerStatsSchema coerces its numbers to bigint, and a bigint cannot be
 * written to a jsonb column — the driver calls JSON.stringify on it and throws
 * "Do not know how to serialize a BigInt". The raw body still holds the
 * numeric strings the game server sent, which is also the form that round-trips
 * back out unchanged.
 */
function rawStatsByClientId(raw: unknown): Map<string, unknown> {
  const players = (raw as { info?: { players?: unknown[] } })?.info?.players;
  if (!Array.isArray(players)) return new Map();

  const byClient = new Map<string, unknown>();
  for (const player of players) {
    if (typeof player !== "object" || player === null) continue;
    const { clientID, stats } = player as {
      clientID?: unknown;
      stats?: unknown;
    };
    if (typeof clientID === "string") byClient.set(clientID, stats ?? null);
  }
  return byClient;
}

/**
 * Flattens the record's players into participant rows.
 *
 * Guests are recorded too: `userId` stays null for a player with no account,
 * so the row still counts toward the game's history and the name is preserved.
 * Only the account link is missing, which is exactly what a guest is.
 */
async function buildParticipants(
  gameId: string,
  record: GameRecord,
  raw: unknown,
): Promise<(typeof gameParticipants.$inferInsert)[]> {
  const winners = winningClientIds(record);
  const userIds = await resolveUserIds(record);
  const rawStats = rawStatsByClientId(raw);

  return record.info.players.map((player) => ({
    gameId,
    clientId: player.clientID,
    userId: userIds.get(player.clientID) ?? null,
    playerName: player.username,
    clanTag: player.clanTag ?? null,
    team: teamOf(player),
    // Placement is not in the record — the game reports who won, not a full
    // ordering — so it stays null rather than being invented. Null means
    // "unknown", which a leaderboard can skip; a fabricated rank could not be
    // told apart from a real one.
    placement: null,
    won: winners.size === 0 ? null : winners.has(player.clientID),
    // Per-player stats, as recorded. Copied out of the blob so a leaderboard
    // can aggregate without opening `games.record`.
    stats: rawStats.get(player.clientID) ?? null,
  }));
}

/**
 * Maps clientIDs to account ids via the record's persistentIDs.
 *
 * `PlayerRecord.persistentID` is the account's user id (the JWT `sub`), but it
 * is not always one: the game server writes "" for a player who had already
 * left when the record was built (GameServer.archiveGame), and a guest has
 * none. Anything that is not a uuid we hold is simply left unlinked.
 */
async function resolveUserIds(
  record: GameRecord,
): Promise<Map<string, string>> {
  const byPersistentId = new Map<string, string[]>();
  for (const player of record.info.players) {
    const pid = player.persistentID;
    if (!pid || !UUID_RE.test(pid)) continue;
    const clients = byPersistentId.get(pid) ?? [];
    clients.push(player.clientID);
    byPersistentId.set(pid, clients);
  }
  if (byPersistentId.size === 0) return new Map();

  // Only ids that exist in `users` may be written: the column is a foreign
  // key, and a stale persistentID would abort the whole archive insert.
  const known = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, [...byPersistentId.keys()]));

  const result = new Map<string, string>();
  for (const { id } of known) {
    for (const clientId of byPersistentId.get(id) ?? []) {
      result.set(clientId, id);
    }
  }
  return result;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rewrites each player's `persistentID` with `map`, leaving everything else in
 * the record untouched. Shared by the two transforms below so both agree on
 * exactly which bytes they may touch.
 */
function mapPersistentIds(
  record: unknown,
  map: (value: unknown) => unknown,
): unknown {
  if (typeof record !== "object" || record === null) return record;
  const rec = record as { info?: { players?: unknown[] } };
  const players = rec.info?.players;
  if (!Array.isArray(players)) return record;

  return {
    ...rec,
    info: {
      ...rec.info,
      players: players.map((player) =>
        typeof player === "object" && player !== null
          ? {
              ...(player as object),
              persistentID: map(
                (player as { persistentID?: unknown }).persistentID,
              ),
            }
          : player,
      ),
    },
  };
}

/**
 * Turns the empty-string persistentID the game server writes into null.
 *
 * GameServer.archiveGame() writes `?? ""` for a player who had already
 * disconnected when the record was assembled, but the game's own
 * PersistentIdSchema is `z.uuid().nullable()` — "" satisfies neither. Left
 * alone it fails validation on both ends: we would reject the POST, and a
 * client that did receive it would call the replay a version mismatch.
 *
 * "" and null already mean the same thing (no account attached), so it is
 * normalised once on ingest and the normalised form is what gets archived.
 */
export function normalizeEmptyPersistentIds(record: unknown): unknown {
  return mapPersistentIds(record, (value) => (value === "" ? null : value));
}

/**
 * Blanks the PII in a record before it goes out to an untrusted caller.
 *
 * `persistentID` is the player's account id and is flagged "WARNING: PII" in
 * the game's own schema. It is archived because the game server writes it, but
 * GET /game/:id is fetched by the browser with no credentials at all
 * (JoinLobbyModal.checkArchivedGame), so it must not go out on that path.
 *
 * The field is required-but-nullable in GameRecordSchema, so it is set to null
 * rather than deleted: the client validates the response with that schema and
 * would treat a missing key as a version mismatch. Replays never read it — the
 * simulation is keyed on clientID.
 */
export function stripPersistentIds(record: unknown): unknown {
  return mapPersistentIds(record, () => null);
}

/** The stored record for a game, or null. */
export async function getGameRecord(gameId: string): Promise<unknown | null> {
  const [row] = await db
    .select({ record: games.record })
    .from(games)
    .where(eq(games.id, gameId));
  return row?.record ?? null;
}
