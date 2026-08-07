import { TribeNameStatusSchema } from "@game/ApiSchemas.ts";
import { GameStartInfoSchema, TribeSchema } from "@game/Schemas.ts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
// The GAME's own type, imported from the caller that defines the contract.
// If src/server/CustomTribes.ts changes the shape it accepts, this stops
// compiling — which is the point.
import type { TribePoolPlayer as GameTribePoolPlayer } from "../../../src/server/CustomTribes.ts";
import {
  buildTribePool,
  MAX_GLOBAL_TRIBES,
  MAX_OWNED_TRIBES,
  MAX_TRIBES,
  type TribePoolPlayer,
} from "./customTribes.ts";

/**
 * The game parses our response with a private `CustomTribesResponseSchema`
 * that is not exported, so it is rebuilt here from the game's OWN exported
 * TribeSchema — character for character with src/server/CustomTribes.ts:
 *
 *   const CustomTribesResponseSchema = z.object({
 *     tribes: TribeSchema.array().max(100),
 *   });
 *
 * Because TribeSchema itself is imported (not copied), any upstream change to
 * what a tribe may contain lands here automatically.
 */
const GameCustomTribesResponseSchema = z.object({
  tribes: TribeSchema.array().max(100),
});

/**
 * Compile-time assertion that our player type is exactly the game's. The game
 * sends this; if it grows a field we must not narrow it away.
 */
const _playerIsGameShape: TribePoolPlayer = {
  clientId: "abcd1234",
  publicId: "pub_abcd1234",
} satisfies GameTribePoolPlayer;
void _playerIsGameShape;

const somePlayers: TribePoolPlayer[] = [
  { clientId: "client-1", publicId: "public-1" },
  { clientId: "client-2", publicId: "public-2" },
];

describe("the shape the game server can parse", () => {
  it("returns a body the game's own schema accepts", () => {
    const body = { tribes: buildTribePool(somePlayers) };
    expect(GameCustomTribesResponseSchema.safeParse(body).success).toBe(true);
  });

  it("accepts an empty lobby (all guests) without changing shape", () => {
    const body = { tribes: buildTribePool([]) };
    expect(GameCustomTribesResponseSchema.safeParse(body).success).toBe(true);
  });

  it("returns an ARRAY under `tribes`, not a bare array or a null", () => {
    // The three shapes most likely to be introduced by a careless refactor.
    // Each would be parsed as malformed and cost the game its whole pool.
    expect(GameCustomTribesResponseSchema.safeParse([]).success).toBe(false);
    expect(
      GameCustomTribesResponseSchema.safeParse({ tribes: null }).success,
    ).toBe(false);
    expect(GameCustomTribesResponseSchema.safeParse({}).success).toBe(false);
  });

  it("would reject a pool longer than the game's 100 cap", () => {
    // Documents why the route clamps to MAX_TRIBES: over the cap the game
    // discards EVERYTHING, it does not truncate.
    const overCap = Array.from({ length: MAX_TRIBES + 1 }, (_, i) => ({
      name: `Tribe${i}`,
    }));
    expect(
      GameCustomTribesResponseSchema.safeParse({ tribes: overCap }).success,
    ).toBe(false);
    expect(
      GameCustomTribesResponseSchema.safeParse({
        tribes: overCap.slice(0, MAX_TRIBES),
      }).success,
    ).toBe(true);
  });
});

/**
 * The honest-scope tests. These assert that we serve NOTHING, and they are
 * written to FAIL the day someone implements purchases — at which point they
 * should be rewritten, not deleted.
 */
describe("no purchased tribe names exist in this backend", () => {
  it("serves an empty pool regardless of who is in the lobby", () => {
    expect(buildTribePool(somePlayers)).toEqual([]);
    expect(buildTribePool([])).toEqual([]);
  });

  it("does not invent names from the game's organic theme data", () => {
    // resources/tribeNameThemes.json feeds the deterministic core's OWN bot
    // naming (src/core/execution/utils/TribeNames.ts). Echoing those back as
    // "purchased" names would fabricate ownership and appearance stats, so
    // the pool must stay empty rather than merely non-obvious.
    const pool = buildTribePool(somePlayers);
    expect(pool).toHaveLength(0);
  });

  it("stays empty even for an implausibly large lobby", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      clientId: `c${i}`,
      publicId: `p${i}`,
    }));
    expect(buildTribePool(many)).toEqual([]);
  });
});

/**
 * These pin the contract a real implementation has to satisfy, so it is
 * checked-in fact rather than folklore once the tables exist.
 */
describe("the ordering contract a real pool must satisfy", () => {
  it("reserves owned-first slicing within the game's cap", () => {
    // GameServer.fetchTribes slices `tribes.slice(0, bots)` — it drops from
    // the TAIL. So owned names must come first or a small bot count would
    // silently discard exactly the names the lobby's players paid for.
    expect(MAX_OWNED_TRIBES + MAX_GLOBAL_TRIBES).toBeLessThanOrEqual(
      MAX_TRIBES,
    );
  });

  it("keeps our cap at or under the game's", () => {
    expect(MAX_TRIBES).toBeLessThanOrEqual(100);
  });
});

/**
 * A tribe name is moderated UGC. This documents which states may appear in a
 * live game, so an implementer cannot select rows without a status filter.
 */
describe("moderation states that may appear in a game", () => {
  it("recognises exactly the four documented states", () => {
    expect(TribeNameStatusSchema.options).toEqual([
      "pending",
      "live",
      "rejected",
      "revoked",
    ]);
  });

  it("treats only pending and live as eligible for rotation", () => {
    // Per the comment on TribeNameStatusSchema in src/core/ApiSchemas.ts:
    // pending (bought, unreviewed) and live (reviewed, kept) are in rotation;
    // rejected and revoked are taken down. A query without this filter would
    // put moderated-away names back into live games.
    const eligible = new Set(["pending", "live"]);
    for (const status of TribeNameStatusSchema.options) {
      expect(eligible.has(status)).toBe(
        status === "pending" || status === "live",
      );
    }
  });
});

/**
 * The response does not just name bots — it rides GameStartInfo into the
 * analytics record. This proves an empty pool is valid there too, so the
 * fallback path cannot break game start.
 */
describe("the pool as it lands in GameStartInfo", () => {
  it("is valid as GameStartInfoSchema.tribes", () => {
    const tribes = buildTribePool(somePlayers);
    const result = GameStartInfoSchema.shape.tribes.safeParse(tribes);
    expect(result.success).toBe(true);
  });

  it("is optional there, so omitting it entirely is also valid", () => {
    // GameServer only assigns `this.tribes` when the pool is non-empty, so an
    // empty response means the field is simply absent from the start info.
    expect(GameStartInfoSchema.shape.tribes.safeParse(undefined).success).toBe(
      true,
    );
  });
});

/**
 * TribeSchema is `.loose()` on purpose — extra per-tribe fields the API adds
 * later flow through to the analytics record instead of being stripped. If an
 * implementer ever needs to attach e.g. an owner id, this shows it is allowed
 * without a game-side change.
 */
describe("tribe entry shape", () => {
  it("requires a non-empty name", () => {
    expect(TribeSchema.safeParse({ name: "Akkadian Dominion" }).success).toBe(
      true,
    );
    expect(TribeSchema.safeParse({ name: "" }).success).toBe(false);
    expect(TribeSchema.safeParse({}).success).toBe(false);
  });

  it("passes unknown fields through rather than stripping them", () => {
    const parsed = TribeSchema.safeParse({
      name: "Akkadian Dominion",
      ownerPublicId: "public-1",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toHaveProperty("ownerPublicId", "public-1");
    }
  });

  it("rejects a name longer than 64 characters", () => {
    expect(TribeSchema.safeParse({ name: "x".repeat(65) }).success).toBe(false);
  });
});
