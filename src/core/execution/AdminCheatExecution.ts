import { AdminCheatAction } from "../Schemas";
import { toInt } from "../Util";
import { Execution, Game, Player, PlayerID, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { ConstructionExecution } from "./ConstructionExecution";

/**
 * Applies one admin cheat.
 *
 * Authorization does NOT happen here. The simulation runs on every client and
 * has no notion of who is an admin — by the time an intent reaches this class
 * it is already in the turn and every client is executing it. The only
 * enforcement point is GameServer.handleIntent, which refuses to put the
 * intent in a turn unless the sending connection holds an admin role.
 *
 * Consequences of that, which shape everything below:
 *
 *  - Every effect must be deterministic. All clients run this code and compare
 *    state hashes; a cheat that behaves differently anywhere desyncs the game.
 *    No Math.random, no wall-clock, no float accumulation into persistent
 *    state.
 *  - Every effect must be expressible through the ordinary Player/Game API. A
 *    cheat cannot reach past the simulation, because there is nothing to reach
 *    past to — this IS the simulation.
 *  - Nothing here may throw. An exception escapes into executeNextTick on every
 *    client at once. Invalid input is warned about and dropped.
 *
 * One-shot: does its work on the first tick, then goes inactive.
 */
export class AdminCheatExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private player: Player,
    private action: AdminCheatAction,
    private params: {
      amount?: number;
      targetID?: PlayerID;
      tile?: TileRef;
      unitType?: UnitType;
      enabled?: boolean;
    },
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    // Inactive before anything else runs: every branch below is one-shot, and
    // an early return must not leave the execution alive to repeat next tick.
    this.active = false;

    try {
      this.apply();
    } catch (err) {
      // A throw here would propagate out of executeNextTick on every client
      // simultaneously. A cheat is never worth killing the game for.
      console.warn(`admin cheat ${this.action} failed`, err);
    }
  }

  private apply(): void {
    switch (this.action) {
      case "give_gold":
        return this.giveGold();
      case "give_troops":
        return this.giveTroops();
      case "set_troops":
        return this.setTroops();
      case "spawn_unit":
        return this.spawnUnit();
      case "capture_tile":
        return this.captureTile();
      case "god_mode":
        return this.godMode();
      case "kill_player":
        return this.killPlayer();
      case "force_alliance":
        return this.forceAlliance();
      case "break_alliance":
        return this.breakAlliance();
    }
  }

  /** Resolves a target id to a live player, or null with a warning. */
  private target(): Player | null {
    const id = this.params.targetID;
    if (id === undefined || !this.mg.hasPlayer(id)) {
      console.warn(`admin cheat ${this.action}: no such player ${id}`);
      return null;
    }
    return this.mg.player(id);
  }

  /**
   * A positive, finite amount. Guards the sim against NaN and Infinity, which
   * would otherwise poison gold or troop totals permanently — and identically
   * on every client, so the desync detector would not even catch it.
   */
  private amount(): number | null {
    const value = this.params.amount;
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      console.warn(`admin cheat ${this.action}: bad amount ${value}`);
      return null;
    }
    return value;
  }

  private giveGold(): void {
    const amount = this.amount();
    if (amount === null) return;
    // toInt truncates toward zero, matching how gold is handled everywhere
    // else; gold is bigint in the sim and only becomes a number on the wire.
    this.player.addGold(toInt(amount));
  }

  private giveTroops(): void {
    const amount = this.amount();
    if (amount === null) return;
    this.player.addTroops(amount);
  }

  private setTroops(): void {
    const amount = this.amount();
    if (amount === null) return;
    this.player.setTroops(amount);
  }

  /**
   * Places a unit by delegating to ConstructionExecution, after covering the
   * cost with a grant.
   *
   * Deliberately not a raw buildUnit call: each unit type needs different
   * params (nukes need a trajectory, warships a patrol tile) and has its own
   * follow-up execution. ConstructionExecution already encodes all of that
   * correctly, so the cheat is "you can always afford it", not "the rules do
   * not apply". Placement still has to be legal — a port still needs water.
   */
  private spawnUnit(): void {
    const { unitType, tile } = this.params;
    if (unitType === undefined) {
      console.warn("admin cheat spawn_unit: no unit type");
      return;
    }
    if (tile === undefined || !this.mg.isValidRef(tile)) {
      console.warn(`admin cheat spawn_unit: invalid tile ${tile}`);
      return;
    }
    if (this.mg.config().isUnitDisabled(unitType)) {
      console.warn(`admin cheat spawn_unit: ${unitType} is disabled`);
      return;
    }

    const cost = this.mg.unitInfo(unitType).cost(this.mg, this.player);
    if (cost > 0n) this.player.addGold(cost);

    this.mg.addExecution(
      new ConstructionExecution(this.player, unitType, tile),
    );
  }

  /**
   * Takes a single tile for the cheating player.
   *
   * conquer() is the same call the attack system makes, so ownership, borders
   * and the render diff all update the way they normally do. Water is refused
   * because conquering it corrupts the border sets.
   */
  private captureTile(): void {
    const tile = this.params.tile;
    if (tile === undefined || !this.mg.isValidRef(tile)) {
      console.warn(`admin cheat capture_tile: invalid tile ${tile}`);
      return;
    }
    if (!this.mg.isLand(tile)) {
      console.warn("admin cheat capture_tile: not a land tile");
      return;
    }
    if (this.mg.owner(tile) === this.player) return;
    this.player.conquer(tile);
  }

  private godMode(): void {
    this.player.setAdminGodMode(this.params.enabled === true);
  }

  /**
   * Removes a player from the game by handing their territory to the caller,
   * which is exactly what happens when a player is conquered normally.
   */
  private killPlayer(): void {
    const target = this.target();
    if (target === null) return;
    if (target === this.player) {
      console.warn("admin cheat kill_player: cannot kill yourself");
      return;
    }
    if (!target.isAlive()) return;

    // Snapshot: relinquishing mutates the live tile set as we walk it.
    for (const tile of Array.from(target.tiles())) {
      this.player.conquer(tile);
    }
    this.mg.conquerPlayer(this.player, target);
  }

  /**
   * Forces an alliance by creating a request and immediately accepting it —
   * the same two calls the normal flow makes, so alliance state, expiry and
   * the UI all behave as they would otherwise.
   */
  private forceAlliance(): void {
    const target = this.target();
    if (target === null) return;
    if (target === this.player) return;
    if (this.player.isAlliedWith(target)) return;

    const request = this.player.createAllianceRequest(target);
    if (request === null) {
      console.warn("admin cheat force_alliance: request refused");
      return;
    }
    request.accept();
  }

  private breakAlliance(): void {
    const target = this.target();
    if (target === null) return;
    const alliance = this.player.allianceWith(target);
    if (alliance === null) return;
    this.player.breakAlliance(alliance);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    // Cheats are for a running game. Granting territory or units mid-spawn
    // would race the spawn system for the same tiles.
    return false;
  }
}
