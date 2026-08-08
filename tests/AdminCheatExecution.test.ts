import { AdminCheatExecution } from "../src/core/execution/AdminCheatExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Relation,
  UnitType,
} from "../src/core/game/Game";
import { GameID } from "../src/core/Schemas";
import { setup } from "./util/Setup";

const gameID: GameID = "cheat_game";

/**
 * Admin cheats run inside the deterministic simulation on every client, so
 * these tests care about two things above all:
 *
 *  - the effect actually lands, and
 *  - malformed input is dropped rather than thrown, because an exception here
 *    escapes executeNextTick on every client simultaneously.
 *
 * Authorization is deliberately NOT tested here: the simulation has no concept
 * of an admin. The only gate is GameServer.handleIntent, covered separately in
 * AdminCheatAuthorization.test.ts.
 */

async function twoPlayerGame(): Promise<{
  game: Game;
  admin: Player;
  victim: Player;
}> {
  const game = await setup("ocean_and_land", { infiniteGold: false });

  const adminInfo = new PlayerInfo("admin", PlayerType.Human, null, "admin_id");
  const victimInfo = new PlayerInfo(
    "victim",
    PlayerType.Human,
    null,
    "victim_id",
  );
  game.addPlayer(adminInfo);
  game.addPlayer(victimInfo);

  game.addExecution(
    new SpawnExecution(gameID, adminInfo, game.ref(0, 10)),
    new SpawnExecution(gameID, victimInfo, game.ref(0, 15)),
  );
  for (let i = 0; i < 3; i++) game.executeNextTick();

  return {
    game,
    admin: game.player(adminInfo.id),
    victim: game.player(victimInfo.id),
  };
}

/** Runs a cheat to completion. Executions init on one tick and run the next. */
function runCheat(game: Game, exec: AdminCheatExecution, ticks = 4): void {
  game.addExecution(exec);
  for (let i = 0; i < ticks; i++) game.executeNextTick();
}

/**
 * Gold and troops grow passively every tick, so absolute before/after
 * assertions are meaningless — the income arrives whether the cheat fired or
 * not. Each of these runs the same number of ticks with and without the cheat
 * and compares the two, which isolates the cheat's own contribution.
 */
async function goldDeltaFromCheat(
  build: (player: Player) => AdminCheatExecution,
  ticks = 4,
): Promise<bigint> {
  const control = await twoPlayerGame();
  const controlBefore = control.admin.gold();
  for (let i = 0; i < ticks; i++) control.game.executeNextTick();
  const passive = control.admin.gold() - controlBefore;

  const test = await twoPlayerGame();
  const testBefore = test.admin.gold();
  runCheat(test.game, build(test.admin), ticks);
  const total = test.admin.gold() - testBefore;

  return total - passive;
}

describe("AdminCheatExecution — resources", () => {
  it("give_gold adds exactly the requested amount", async () => {
    const delta = await goldDeltaFromCheat(
      (admin) => new AdminCheatExecution(admin, "give_gold", { amount: 5000 }),
    );

    expect(delta).toBe(5000n);
  });

  it("give_troops adds troops", async () => {
    const { game, admin } = await twoPlayerGame();
    const before = admin.troops();

    runCheat(
      game,
      new AdminCheatExecution(admin, "give_troops", { amount: 1000 }),
    );

    expect(admin.troops()).toBeGreaterThan(before);
  });

  it("set_troops replaces the troop count outright", async () => {
    const { game, admin } = await twoPlayerGame();

    // Only one tick after the execution runs, so troop growth cannot drift the
    // value far from what was set. Asserting an exact number would be testing
    // the growth formula, not the cheat.
    runCheat(
      game,
      new AdminCheatExecution(admin, "set_troops", { amount: 777 }),
      3,
    );

    expect(admin.troops()).toBeGreaterThanOrEqual(777);
    expect(admin.troops()).toBeLessThan(900);
  });

  it("drops a NaN amount instead of poisoning the gold total", async () => {
    // NaN would propagate identically on every client, so the desync detector
    // would never catch it — this guard is the only thing that does.
    const delta = await goldDeltaFromCheat(
      (admin) =>
        new AdminCheatExecution(admin, "give_gold", { amount: Number.NaN }),
    );

    expect(delta).toBe(0n);
  });

  it("drops an Infinite amount", async () => {
    const delta = await goldDeltaFromCheat(
      (admin) =>
        new AdminCheatExecution(admin, "give_gold", {
          amount: Number.POSITIVE_INFINITY,
        }),
    );

    expect(delta).toBe(0n);
  });

  it("drops a negative amount", async () => {
    const delta = await goldDeltaFromCheat(
      (admin) => new AdminCheatExecution(admin, "give_gold", { amount: -100 }),
    );

    expect(delta).toBe(0n);
  });

  it("drops a missing amount", async () => {
    const delta = await goldDeltaFromCheat(
      (admin) => new AdminCheatExecution(admin, "give_gold", {}),
    );

    expect(delta).toBe(0n);
  });
});

describe("AdminCheatExecution — god mode", () => {
  it("makes the player immune and is reversible", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    expect(admin.isImmune()).toBe(false);

    runCheat(
      game,
      new AdminCheatExecution(admin, "god_mode", { enabled: true }),
    );
    expect(admin.isImmune()).toBe(true);
    // The point of immunity: nobody can attack them.
    expect(victim.canAttackPlayer(admin)).toBe(false);

    runCheat(
      game,
      new AdminCheatExecution(admin, "god_mode", { enabled: false }),
    );
    expect(admin.isImmune()).toBe(false);
  });

  it("treats a missing enabled flag as off", async () => {
    const { game, admin } = await twoPlayerGame();

    runCheat(game, new AdminCheatExecution(admin, "god_mode", {}));

    expect(admin.isImmune()).toBe(false);
  });
});

describe("AdminCheatExecution — territory", () => {
  it("capture_tile takes a land tile", async () => {
    const { game, admin } = await twoPlayerGame();
    const before = admin.numTilesOwned();

    // A land tile the admin does not already own.
    let target: number | null = null;
    for (let y = 0; y < 20 && target === null; y++) {
      for (let x = 0; x < 20; x++) {
        const tile = game.ref(x, y);
        if (game.isLand(tile) && game.owner(tile) !== admin) {
          target = tile;
          break;
        }
      }
    }
    expect(target).not.toBeNull();

    runCheat(
      game,
      new AdminCheatExecution(admin, "capture_tile", { tile: target! }),
    );

    expect(admin.numTilesOwned()).toBeGreaterThan(before);
    expect(game.owner(target!)).toBe(admin);
  });

  it("refuses a water tile rather than corrupting the border set", async () => {
    const { game, admin } = await twoPlayerGame();
    const before = admin.numTilesOwned();

    let water: number | null = null;
    for (let y = 0; y < 20 && water === null; y++) {
      for (let x = 0; x < 20; x++) {
        const tile = game.ref(x, y);
        if (!game.isLand(tile)) {
          water = tile;
          break;
        }
      }
    }
    expect(water).not.toBeNull();

    runCheat(
      game,
      new AdminCheatExecution(admin, "capture_tile", { tile: water! }),
    );

    expect(admin.numTilesOwned()).toBe(before);
  });

  it("drops an out-of-range tile ref without throwing", async () => {
    const { game, admin } = await twoPlayerGame();
    const before = admin.numTilesOwned();

    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "capture_tile", { tile: 99_999_999 }),
      ),
    ).not.toThrow();
    expect(admin.numTilesOwned()).toBe(before);
  });
});

describe("AdminCheatExecution — players", () => {
  it("kill_player transfers the target's territory and ends them", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    expect(victim.numTilesOwned()).toBeGreaterThan(0);

    runCheat(
      game,
      new AdminCheatExecution(admin, "kill_player", {
        targetID: victim.id(),
      }),
    );

    expect(victim.numTilesOwned()).toBe(0);
    expect(victim.isAlive()).toBe(false);
  });

  it("refuses to kill yourself", async () => {
    const { game, admin } = await twoPlayerGame();

    runCheat(
      game,
      new AdminCheatExecution(admin, "kill_player", { targetID: admin.id() }),
    );

    expect(admin.isAlive()).toBe(true);
  });

  it("drops an unknown target id", async () => {
    const { game, admin } = await twoPlayerGame();

    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "kill_player", {
          targetID: "no_such_player",
        }),
      ),
    ).not.toThrow();
  });

  it("force_alliance allies both sides, break_alliance undoes it", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    expect(admin.isAlliedWith(victim)).toBe(false);

    runCheat(
      game,
      new AdminCheatExecution(admin, "force_alliance", {
        targetID: victim.id(),
      }),
    );
    expect(admin.isAlliedWith(victim)).toBe(true);
    // Alliances are mutual; the target must see it too.
    expect(victim.isAlliedWith(admin)).toBe(true);

    runCheat(
      game,
      new AdminCheatExecution(admin, "break_alliance", {
        targetID: victim.id(),
      }),
    );
    expect(admin.isAlliedWith(victim)).toBe(false);
  });

  it("force_alliance with yourself is a no-op", async () => {
    const { game, admin } = await twoPlayerGame();

    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "force_alliance", {
          targetID: admin.id(),
        }),
      ),
    ).not.toThrow();
  });

  it("break_alliance where none exists is a no-op", async () => {
    const { game, admin, victim } = await twoPlayerGame();

    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "break_alliance", {
          targetID: victim.id(),
        }),
      ),
    ).not.toThrow();
  });
});

describe("AdminCheatExecution — unit spawning", () => {
  it("spawns a structure without the player being able to afford it", async () => {
    const { game, admin } = await twoPlayerGame();
    // Deliberately broke: the cheat has to cover the cost itself.
    admin.removeGold(admin.gold());
    expect(admin.gold()).toBe(0n);

    const owned = admin.tiles();
    const spawnTile = Array.from(owned)[0];
    expect(spawnTile).toBeDefined();

    runCheat(
      game,
      new AdminCheatExecution(admin, "spawn_unit", {
        unitType: UnitType.City,
        tile: spawnTile,
      }),
      6,
    );

    expect(admin.unitCount(UnitType.City)).toBeGreaterThan(0);
  });

  it("drops a missing unit type", async () => {
    const { game, admin } = await twoPlayerGame();
    const spawnTile = Array.from(admin.tiles())[0];

    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "spawn_unit", { tile: spawnTile }),
      ),
    ).not.toThrow();
  });

  it("drops an invalid tile", async () => {
    const { game, admin } = await twoPlayerGame();

    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "spawn_unit", {
          unitType: UnitType.City,
          tile: 99_999_999,
        }),
      ),
    ).not.toThrow();
  });
});

describe("AdminCheatExecution — lifecycle", () => {
  it("runs once and then goes inactive", async () => {
    // A cheat that stayed active would grant on every one of these ticks, so
    // the delta over many ticks must still be exactly one grant.
    const delta = await goldDeltaFromCheat(
      (admin) => new AdminCheatExecution(admin, "give_gold", { amount: 100 }),
      10,
    );

    expect(delta).toBe(100n);
  });

  it("reports itself inactive after running", async () => {
    const { game, admin } = await twoPlayerGame();
    const exec = new AdminCheatExecution(admin, "give_gold", { amount: 100 });

    runCheat(game, exec);

    expect(exec.isActive()).toBe(false);
  });

  it("does not run during the spawn phase", async () => {
    // autoEndSpawnPhase=false keeps the game in spawn, where granting
    // territory or units would race the spawn system for the same tiles.
    const game = await setup(
      "ocean_and_land",
      {},
      [],
      undefined,
      undefined,
      false,
    );
    const info = new PlayerInfo("admin", PlayerType.Human, null, "admin_id");
    game.addPlayer(info);
    const admin = game.player(info.id);
    const before = admin.gold();

    game.addExecution(
      new AdminCheatExecution(admin, "give_gold", { amount: 5000 }),
    );
    for (let i = 0; i < 3; i++) game.executeNextTick();

    expect(game.inSpawnPhase()).toBe(true);
    // Passive income does not run during spawn either, so an exact comparison
    // is safe here — and anything at all would mean the cheat fired.
    expect(admin.gold()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Expanded cheat set
// ---------------------------------------------------------------------------

describe("AdminCheatExecution — expanded resources", () => {
  it("max_troops fills to the configured ceiling", async () => {
    const { game, admin } = await twoPlayerGame();
    admin.setTroops(1);

    runCheat(game, new AdminCheatExecution(admin, "max_troops", {}), 3);

    // The exact ceiling depends on territory, so assert against the config
    // rather than a hardcoded number — that is the value being claimed.
    expect(admin.troops()).toBeGreaterThanOrEqual(
      game.config().maxTroops(admin) * 0.9,
    );
  });
});

describe("AdminCheatExecution — expanded territory", () => {
  it("capture_radius takes unowned land around the tile", async () => {
    const { game, admin } = await twoPlayerGame();

    // Seed from land the admin does NOT own. Seeding inside their own
    // territory captures nothing on this map — the spawn pocket is a ~25 tile
    // island they already hold outright — which would make the assertion
    // vacuous rather than wrong.
    let seed: number | null = null;
    for (let y = 0; y < 40 && seed === null; y++) {
      for (let x = 0; x < 40; x++) {
        const tile = game.ref(x, y);
        if (game.isLand(tile) && game.owner(tile) !== admin) {
          seed = tile;
          break;
        }
      }
    }
    expect(seed).not.toBeNull();
    const before = admin.numTilesOwned();

    runCheat(
      game,
      new AdminCheatExecution(admin, "capture_radius", {
        tile: seed!,
        amount: 3,
      }),
    );

    expect(admin.numTilesOwned()).toBeGreaterThan(before);
    expect(game.owner(seed!)).toBe(admin);
  });

  it("capture_radius on fully-owned land is a no-op, not an error", async () => {
    const { game, admin } = await twoPlayerGame();
    const before = admin.numTilesOwned();
    const seed = Array.from(admin.tiles())[0];

    runCheat(
      game,
      new AdminCheatExecution(admin, "capture_radius", {
        tile: seed,
        amount: 3,
      }),
    );

    expect(admin.numTilesOwned()).toBe(before);
  });

  it("capture_radius never takes water", async () => {
    const { game, admin } = await twoPlayerGame();

    const seed = Array.from(admin.tiles())[0];
    runCheat(
      game,
      new AdminCheatExecution(admin, "capture_radius", {
        tile: seed,
        amount: 8,
      }),
    );

    // Conquering water corrupts the border sets, so every owned tile must
    // still be land afterwards.
    for (const tile of admin.tiles()) {
      expect(game.isLand(tile)).toBe(true);
    }
  });

  it("capture_radius drops an invalid tile without throwing", async () => {
    const { game, admin } = await twoPlayerGame();
    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "capture_radius", {
          tile: 99_999_999,
          amount: 3,
        }),
      ),
    ).not.toThrow();
  });

  it("clear_units deletes the caller's units", async () => {
    const { game, admin } = await twoPlayerGame();
    admin.addGold(10_000_000n);
    const spawnTile = Array.from(admin.tiles())[0];
    runCheat(
      game,
      new AdminCheatExecution(admin, "spawn_unit", {
        unitType: UnitType.City,
        tile: spawnTile,
      }),
      6,
    );
    expect(admin.unitCount(UnitType.City)).toBeGreaterThan(0);

    runCheat(game, new AdminCheatExecution(admin, "clear_units", {}), 4);

    expect(admin.unitCount(UnitType.City)).toBe(0);
  });

  it("upgrade_structures does not throw with nothing to upgrade", async () => {
    const { game, admin } = await twoPlayerGame();
    expect(() =>
      runCheat(game, new AdminCheatExecution(admin, "upgrade_structures", {})),
    ).not.toThrow();
  });
});

describe("AdminCheatExecution — expanded self state", () => {
  it("clear_traitor removes the traitor mark", async () => {
    const { game, admin } = await twoPlayerGame();
    admin.markTraitor();
    expect(admin.isTraitor()).toBe(true);

    runCheat(game, new AdminCheatExecution(admin, "clear_traitor", {}));

    expect(admin.isTraitor()).toBe(false);
  });

  it("clear_doomsday leaves the clock cleared", async () => {
    const { game, admin } = await twoPlayerGame();
    admin.enterDoomsdayClock();

    runCheat(game, new AdminCheatExecution(admin, "clear_doomsday", {}));

    expect(admin.inDoomsdayClock()).toBe(false);
  });
});

describe("AdminCheatExecution — expanded player actions", () => {
  it("steal_gold moves the whole balance", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    victim.addGold(50_000n);
    const victimBefore = victim.gold();
    const adminBefore = admin.gold();
    expect(victimBefore).toBeGreaterThan(0n);

    runCheat(
      game,
      new AdminCheatExecution(admin, "steal_gold", { targetID: victim.id() }),
      2,
    );

    expect(admin.gold()).toBeGreaterThan(adminBefore);
    // Income resumes the tick after, so assert it dropped rather than hit 0.
    expect(victim.gold()).toBeLessThan(victimBefore);
  });

  it("steal_gold refuses to target yourself", async () => {
    const { game, admin } = await twoPlayerGame();
    const before = admin.gold();

    runCheat(
      game,
      new AdminCheatExecution(admin, "steal_gold", { targetID: admin.id() }),
      2,
    );

    // Stealing from yourself would zero the balance via removeGold.
    expect(admin.gold()).toBeGreaterThanOrEqual(before);
  });

  it("mark_traitor marks the target, not the caller", async () => {
    const { game, admin, victim } = await twoPlayerGame();

    runCheat(
      game,
      new AdminCheatExecution(admin, "mark_traitor", { targetID: victim.id() }),
    );

    expect(victim.isTraitor()).toBe(true);
    expect(admin.isTraitor()).toBe(false);
  });

  it("set_relation drives the score to the top of the range", async () => {
    const { game, admin, victim } = await twoPlayerGame();

    runCheat(
      game,
      new AdminCheatExecution(admin, "set_relation", {
        targetID: victim.id(),
        amount: 100,
      }),
    );

    // Only the derived enum is readable — the raw -100..100 score has no
    // getter. Friendly is what the top of the range maps to.
    expect(victim.relation(admin)).toBe(Relation.Friendly);
  });

  it("set_relation drives the score to the bottom of the range", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    // Start friendly so the move is unambiguous rather than a no-op.
    runCheat(
      game,
      new AdminCheatExecution(admin, "set_relation", {
        targetID: victim.id(),
        amount: 100,
      }),
    );

    runCheat(
      game,
      new AdminCheatExecution(admin, "set_relation", {
        targetID: victim.id(),
        amount: -100,
      }),
    );

    expect(victim.relation(admin)).toBe(Relation.Hostile);
  });

  it("set_relation clamps an out-of-range value instead of overflowing", async () => {
    const { game, admin, victim } = await twoPlayerGame();

    runCheat(
      game,
      new AdminCheatExecution(admin, "set_relation", {
        targetID: victim.id(),
        amount: 9999,
      }),
    );

    expect(victim.relation(admin)).toBe(Relation.Friendly);
  });

  it("set_relation drops a missing amount", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "set_relation", {
          targetID: victim.id(),
        }),
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Giving
// ---------------------------------------------------------------------------

describe("AdminCheatExecution — gifts", () => {
  it("gift_gold credits the target, not the caller", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    const adminBefore = admin.gold();
    const victimBefore = victim.gold();

    runCheat(
      game,
      new AdminCheatExecution(admin, "gift_gold", {
        targetID: victim.id(),
        amount: 50_000,
      }),
      2,
    );

    expect(victim.gold()).toBeGreaterThanOrEqual(victimBefore + 50_000n);
    // The gift is created, not transferred — the caller pays nothing. Passive
    // income means the admin's balance can only have risen, never fallen.
    expect(admin.gold()).toBeGreaterThanOrEqual(adminBefore);
  });

  it("gift_troops adds to the target", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    const before = victim.troops();

    runCheat(
      game,
      new AdminCheatExecution(admin, "gift_troops", {
        targetID: victim.id(),
        amount: 5000,
      }),
      2,
    );

    expect(victim.troops()).toBeGreaterThan(before);
  });

  it("gift_god_mode shields the target and is reversible", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    expect(victim.isImmune()).toBe(false);

    runCheat(
      game,
      new AdminCheatExecution(admin, "gift_god_mode", {
        targetID: victim.id(),
        enabled: true,
      }),
    );
    expect(victim.isImmune()).toBe(true);
    // The point: even the admin who granted it can no longer attack them.
    expect(admin.canAttackPlayer(victim)).toBe(false);

    runCheat(
      game,
      new AdminCheatExecution(admin, "gift_god_mode", {
        targetID: victim.id(),
        enabled: false,
      }),
    );
    expect(victim.isImmune()).toBe(false);
  });

  it("gift_gold drops a NaN amount", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    const before = victim.gold();

    runCheat(
      game,
      new AdminCheatExecution(admin, "gift_gold", {
        targetID: victim.id(),
        amount: Number.NaN,
      }),
      2,
    );

    // Income still accrues, so assert it did not jump by the bogus amount.
    expect(victim.gold()).toBeLessThan(before + 1000n);
  });

  it("gift_gold drops an unknown target", async () => {
    const { game, admin } = await twoPlayerGame();
    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "gift_gold", {
          targetID: "nobody",
          amount: 100,
        }),
      ),
    ).not.toThrow();
  });

  it("pardon_player clears the target's traitor mark", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    victim.markTraitor();
    expect(victim.isTraitor()).toBe(true);

    runCheat(
      game,
      new AdminCheatExecution(admin, "pardon_player", {
        targetID: victim.id(),
      }),
    );

    expect(victim.isTraitor()).toBe(false);
  });

  it("gift_unit builds for the target while they are broke", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    victim.removeGold(victim.gold());
    const tile = Array.from(victim.tiles())[0];

    runCheat(
      game,
      new AdminCheatExecution(admin, "gift_unit", {
        targetID: victim.id(),
        unitType: UnitType.City,
        tile,
      }),
      6,
    );

    expect(victim.unitCount(UnitType.City)).toBeGreaterThan(0);
    // Built for the recipient, not for the caller.
    expect(admin.unitCount(UnitType.City)).toBe(0);
  });
});

describe("AdminCheatExecution — revive", () => {
  it("brings an eliminated player back with land and troops", async () => {
    const { game, admin, victim } = await twoPlayerGame();

    // Eliminate them first, which is what makes revive meaningful.
    runCheat(
      game,
      new AdminCheatExecution(admin, "kill_player", { targetID: victim.id() }),
    );
    expect(victim.isAlive()).toBe(false);

    // Revive onto land the admin now holds.
    const tile = Array.from(admin.tiles())[0];
    runCheat(
      game,
      new AdminCheatExecution(admin, "revive_player", {
        targetID: victim.id(),
        tile,
        amount: 2,
      }),
      4,
    );

    // isAlive() is tiles.size > 0 — there is no separate dead flag, so owning
    // land IS being alive.
    expect(victim.isAlive()).toBe(true);
    expect(victim.numTilesOwned()).toBeGreaterThan(0);
    // Without troops the pocket cannot be held, so the revive grants some.
    expect(victim.troops()).toBeGreaterThan(0);
  });

  it("refuses to revive someone already alive", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    const before = victim.numTilesOwned();
    const tile = Array.from(admin.tiles())[0];

    runCheat(
      game,
      new AdminCheatExecution(admin, "revive_player", {
        targetID: victim.id(),
        tile,
        amount: 3,
      }),
    );

    // Would otherwise be a free land grant to a healthy player.
    expect(victim.numTilesOwned()).toBe(before);
  });

  it("refuses a water tile", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    runCheat(
      game,
      new AdminCheatExecution(admin, "kill_player", { targetID: victim.id() }),
    );

    let water: number | null = null;
    for (let y = 0; y < 20 && water === null; y++) {
      for (let x = 0; x < 20; x++) {
        const tile = game.ref(x, y);
        if (!game.isLand(tile)) {
          water = tile;
          break;
        }
      }
    }

    runCheat(
      game,
      new AdminCheatExecution(admin, "revive_player", {
        targetID: victim.id(),
        tile: water!,
        amount: 3,
      }),
    );

    expect(victim.isAlive()).toBe(false);
  });

  it("drops an invalid tile without throwing", async () => {
    const { game, admin, victim } = await twoPlayerGame();
    runCheat(
      game,
      new AdminCheatExecution(admin, "kill_player", { targetID: victim.id() }),
    );

    expect(() =>
      runCheat(
        game,
        new AdminCheatExecution(admin, "revive_player", {
          targetID: victim.id(),
          tile: 99_999_999,
        }),
      ),
    ).not.toThrow();
  });
});
