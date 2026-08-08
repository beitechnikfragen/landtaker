import { AdminCheatExecution } from "../src/core/execution/AdminCheatExecution";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
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
