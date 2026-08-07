import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@game/game/Game.ts";
import type { GameRecord } from "@game/Schemas.ts";

/**
 * A realistic finished match, shaped exactly as src/server/GameServer.ts
 * archiveGame() builds one. Shared by the unit tests and scripts/smoke-games.sh
 * so both exercise the same record.
 *
 * Built from the game's own enums and typed as GameRecord, so a change to the
 * record on the game side fails the build here rather than leaving a fixture
 * that quietly no longer resembles real traffic.
 *
 * The details that matter and are easy to get wrong:
 *  - two players share the username "Player" — legal, and the reason
 *    game_participants is keyed on clientID rather than on the name;
 *  - one player is a guest, so persistentID is null;
 *  - one player left before the match ended, so the game server wrote "" for
 *    the persistentID (GameServer.ts:1780) instead of a uuid;
 *  - stats are bigint, because PlayerStatsSchema coerces them — this is what
 *    forces the raw body to be archived instead of the parsed record.
 *
 * Every id is 8 alphanumerics, as GAME_ID_REGEX requires of both game ids and
 * clientIDs.
 */

/** The account-linked player's persistentID, asserted on in the PII tests. */
export const FIXTURE_PERSISTENT_ID = "3f7a1c2e-8b4d-4e5f-9a6b-0c1d2e3f4a5b";

export function buildGameRecord(
  overrides: { gameID?: string; gitCommit?: string } = {},
): GameRecord {
  const gameID = overrides.gameID ?? "Tst1Game";
  const start = 1_700_000_000_000;
  const end = start + 612_000; // 10m12s

  return {
    version: "v0.0.2",
    gitCommit: overrides.gitCommit ?? "a".repeat(40),
    domain: "landtaker.io",
    subdomain: "eu",
    info: {
      gameID,
      lobbyCreatedAt: start - 45_000,
      visibleAt: start - 30_000,
      config: {
        gameMap: GameMapType.Europe,
        gameMapSize: GameMapSize.Normal,
        difficulty: Difficulty.Medium,
        gameType: GameType.Public,
        gameMode: GameMode.FFA,
        donateGold: true,
        donateTroops: true,
        nations: "default",
        bots: 40,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
      },
      players: [
        {
          clientID: "aBcD1234",
          username: "Player",
          clanTag: "LTK",
          persistentID: FIXTURE_PERSISTENT_ID,
          isLobbyCreator: true,
          stats: {
            attacks: [12n, 7n, 2n],
            gold: [4200n, 900n, 150n, 0n, 0n, 0n],
            betrayals: 1n,
            units: { city: [3n, 0n, 1n, 0n, 2n], port: [1n, 0n, 0n, 0n, 0n] },
            bombs: { abomb: [2n, 1n, 1n] },
          },
        },
        {
          // Same display name as the player above. Nothing forbids it.
          clientID: "eFgH5678",
          username: "Player",
          clanTag: null,
          // Guest: no account at all.
          persistentID: null,
          stats: {
            attacks: [5n],
            gold: [1800n],
            killedAt: 8400n,
            killedBy: "aBcD1234",
            deathPosition: 3,
          },
        },
        {
          clientID: "iJkL9012",
          username: "Nomad.7",
          clanTag: null,
          // Left before the match ended: GameServer writes "" here, which is
          // not a uuid and must not be mistaken for an account link.
          persistentID: "",
          stats: {
            attacks: [3n],
            gold: [700n],
            killedAt: 5200n,
            deathPosition: 4,
          },
        },
      ],
      start,
      end,
      duration: Math.floor((end - start) / 1000),
      num_turns: 1224,
      winner: ["player", "aBcD1234"],
      lobbyFillTime: 30,
    },
    // A replay is driven entirely by these. Only turns carrying intents or a
    // hash are archived (createPartialGameRecord drops the rest), which is why
    // the turn numbers are sparse.
    turns: [
      {
        turnNumber: 0,
        intents: [
          { type: "spawn", clientID: "aBcD1234", tile: 148_233 },
          { type: "spawn", clientID: "eFgH5678", tile: 91_004 },
          { type: "spawn", clientID: "iJkL9012", tile: 203_781 },
        ],
        hash: 1_073_741_823,
      },
      {
        turnNumber: 1,
        intents: [
          {
            type: "attack",
            clientID: "aBcD1234",
            targetID: "eFgH5678",
            troops: 25_000,
          },
        ],
        hash: 55_123_991,
      },
      // A turn with no intents but a state hash — a replay checks against it.
      { turnNumber: 612, intents: [], hash: -2_014_887_002 },
      {
        turnNumber: 1223,
        intents: [
          {
            type: "boat",
            clientID: "eFgH5678",
            troops: 4000.5,
            dst: 190_004,
          },
        ],
        hash: 900_112_003,
      },
    ],
  };
}
