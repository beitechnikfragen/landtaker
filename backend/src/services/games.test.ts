import { GameRecordSchema } from "@game/Schemas.ts";
import { replacer } from "@game/Util.ts";
import { describe, expect, it } from "vitest";
import { buildGameRecord, FIXTURE_PERSISTENT_ID } from "./gameRecordFixture.ts";
import { normalizeEmptyPersistentIds, stripPersistentIds } from "./games.ts";

/**
 * The archive routes implement the game's own contract, so everything here is
 * asserted against the game's real GameRecordSchema (imported through the
 * @game alias) rather than a local copy of the shape. A local copy would keep
 * passing after the game changed the record — exactly the drift these tests
 * exist to catch.
 *
 * Database behaviour (the upsert, the participant rows) needs a live Postgres
 * and is covered by scripts/smoke-games.sh.
 */

/** The record exactly as it leaves the game server: JSON, bigints stringified. */
function onTheWire(record = buildGameRecord()): any {
  return JSON.parse(JSON.stringify(record, replacer));
}

/** The wire record after the ingest normalisation POST /game/:id applies. */
function ingested(record = buildGameRecord()): any {
  return normalizeEmptyPersistentIds(onTheWire(record));
}

describe("game record contract", () => {
  /**
   * The POST body is produced by JSON.stringify(record, replacer) in
   * src/server/Archive.ts, so what arrives is the *serialized* form — bigint
   * stats already turned into strings. That is what has to validate.
   */
  it("accepts the wire form the game server actually sends", () => {
    expect(GameRecordSchema.safeParse(ingested()).success).toBe(true);
  });

  /**
   * The reason the raw body is archived rather than the parsed record:
   * PlayerStatsSchema coerces its numbers to bigint, and JSON.stringify throws
   * on a bigint. Persisting the parsed value would fail outright — or, with a
   * replacer, quietly rewrite the bytes a replay depends on.
   */
  it("cannot serialize a parsed record without the game's replacer", () => {
    const parsed = GameRecordSchema.parse(ingested());
    expect(() => JSON.stringify(parsed)).toThrow(TypeError);

    // The raw body, by contrast, is plain JSON and round-trips untouched.
    const raw = ingested();
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
  });

  it("preserves turns through a jsonb round trip", () => {
    const raw = ingested();
    // jsonb does not preserve key order, but a replay reads by key, not by
    // position — what must survive is the value of every turn and intent.
    const afterJsonb = JSON.parse(JSON.stringify(raw));
    expect(afterJsonb.turns).toEqual(raw.turns);
    expect(afterJsonb.turns).toHaveLength(raw.turns.length);
    expect(GameRecordSchema.safeParse(afterJsonb).success).toBe(true);
  });

  /**
   * The fixture is only useful if it looks like real traffic. Two players
   * sharing a username is legal and is why game_participants is keyed on
   * clientID — if this stops being true the key choice needs revisiting.
   */
  it("covers a lobby where two players share a username", () => {
    const names = buildGameRecord().info.players.map((p) => p.username);
    expect(new Set(names).size).toBeLessThan(names.length);
  });
});

/**
 * GameServer.archiveGame() writes `?? ""` for a player who had already
 * disconnected when the record was built, but the game's PersistentIdSchema is
 * z.uuid().nullable() — "" is neither. Without normalisation every match where
 * somebody left early is rejected wholesale, replay included.
 */
describe("ingest normalisation of empty persistentIDs", () => {
  it("proves the raw shape really is rejected by the game's schema", () => {
    // Guard for the test below: if the game ever accepts "", the normalisation
    // is dead code and this test says so.
    const raw = onTheWire();
    expect(raw.info.players.some((p: any) => p.persistentID === "")).toBe(true);
    expect(GameRecordSchema.safeParse(raw).success).toBe(false);
  });

  it("makes that record valid by mapping the empty id to null", () => {
    expect(GameRecordSchema.safeParse(ingested()).success).toBe(true);
  });

  it("maps only the empty ids, leaving real ones intact", () => {
    const players = ingested().info.players;
    expect(players[0].persistentID).toBe(FIXTURE_PERSISTENT_ID);
    expect(players[1].persistentID).toBeNull(); // guest, already null
    expect(players[2].persistentID).toBeNull(); // was "", now null
  });

  it("changes nothing outside persistentID", () => {
    const raw = onTheWire();
    const normalized = ingested();
    expect(normalized.turns).toEqual(raw.turns);
    expect(normalized.info.winner).toEqual(raw.info.winner);
    expect(normalized.info.players.map((p: any) => p.username)).toEqual(
      raw.info.players.map((p: any) => p.username),
    );
  });
});

/**
 * persistentID is flagged "WARNING: PII" in the game's schema. GET /game/:id is
 * fetched by the browser with no credentials at all
 * (JoinLobbyModal.checkArchivedGame), so the public response must not carry it.
 */
describe("persistentID stripping", () => {
  it("removes every persistentID", () => {
    const raw = ingested();
    // Guard: the fixture must actually contain one, or this proves nothing.
    expect(raw.info.players.some((p: any) => p.persistentID)).toBe(true);

    const stripped = stripPersistentIds(raw) as any;
    for (const player of stripped.info.players) {
      expect(player.persistentID).toBeNull();
    }
    expect(JSON.stringify(stripped)).not.toContain(FIXTURE_PERSISTENT_ID);
  });

  /**
   * The client parses the GET response with GameRecordSchema and calls a parse
   * failure a version mismatch, so stripping must leave a record that schema
   * still accepts. persistentID is nullable, which is why it is set to null
   * rather than deleted.
   */
  it("leaves a record the game's own schema still accepts", () => {
    const result = GameRecordSchema.safeParse(stripPersistentIds(ingested()));
    expect(result.success).toBe(true);
  });

  /** A replay is driven by the turns, so stripping must not touch them. */
  it("changes nothing else about the record", () => {
    const raw = ingested();
    const stripped = stripPersistentIds(raw) as any;
    expect(stripped.turns).toEqual(raw.turns);
    expect(stripped.gitCommit).toEqual(raw.gitCommit);
    expect(stripped.info.winner).toEqual(raw.info.winner);
    expect(stripped.info.players.map((p: any) => p.username)).toEqual(
      raw.info.players.map((p: any) => p.username),
    );
  });

  it("does not choke on a body that is not a record", () => {
    expect(stripPersistentIds(null)).toBeNull();
    expect(stripPersistentIds({})).toEqual({});
    expect(stripPersistentIds({ info: {} })).toEqual({ info: {} });
  });
});
