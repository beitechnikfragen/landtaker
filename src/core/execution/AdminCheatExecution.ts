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
      case "max_troops":
        return this.maxTroops();
      case "capture_radius":
        return this.captureRadius();
      case "upgrade_structures":
        return this.upgradeStructures();
      case "clear_units":
        return this.clearUnits();
      case "clear_traitor":
        return this.clearTraitor();
      case "clear_doomsday":
        return this.clearDoomsday();
      case "set_relation":
        return this.setRelation();
      case "steal_gold":
        return this.stealGold();
      case "mark_traitor":
        return this.markTraitor();
      case "gift_gold":
        return this.giftGold();
      case "gift_troops":
        return this.giftTroops();
      case "gift_god_mode":
        return this.giftGodMode();
      case "revive_player":
        return this.revivePlayer();
      case "gift_unit":
        return this.giftUnit();
      case "pardon_player":
        return this.pardonPlayer();
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

  /** Fills the troop pool to the configured ceiling for this player. */
  private maxTroops(): void {
    this.player.setTroops(this.mg.config().maxTroops(this.player));
  }

  /**
   * Takes every land tile within `amount` tiles of the selected one.
   *
   * A breadth-first walk rather than a square scan: territory has to stay
   * contiguous for borders to make sense, and BFS over land only guarantees
   * that. Capped so a fat-fingered radius cannot try to conquer the map in one
   * tick — the tile loop is O(area) and runs inside a single execution.
   */
  private captureRadius(): void {
    const tile = this.params.tile;
    if (tile === undefined || !this.mg.isValidRef(tile)) {
      console.warn(`admin cheat capture_radius: invalid tile ${tile}`);
      return;
    }
    const radius = Math.min(Math.floor(this.params.amount ?? 5), 30);
    if (!Number.isFinite(radius) || radius < 1) return;

    const seen = new Set<TileRef>([tile]);
    let frontier: TileRef[] = [tile];
    for (let step = 0; step <= radius && frontier.length > 0; step++) {
      const next: TileRef[] = [];
      for (const current of frontier) {
        if (this.mg.isLand(current) && this.mg.owner(current) !== this.player) {
          this.player.conquer(current);
        }
        for (const neighbor of this.mg.neighbors(current)) {
          if (seen.has(neighbor) || !this.mg.isLand(neighbor)) continue;
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
  }

  /** Upgrades every structure that can be upgraded, ignoring cost. */
  private upgradeStructures(): void {
    // Snapshot: upgrading mutates the player's live unit array.
    for (const unit of [...this.player.units()]) {
      if (this.player.canUpgradeUnit(unit)) {
        this.player.upgradeUnit(unit);
      }
    }
  }

  /** Deletes all of the caller's own units — a way out of a stuck board. */
  private clearUnits(): void {
    for (const unit of [...this.player.units()]) {
      unit.delete(false);
    }
  }

  /**
   * Clears the traitor mark. `markedTraitorTick` is the raw field the decay
   * timer reads; -1 is its "never betrayed" sentinel (PlayerImpl).
   */
  private clearTraitor(): void {
    (
      this.player as unknown as { markedTraitorTick: number }
    ).markedTraitorTick = -1;
  }

  private clearDoomsday(): void {
    this.player.clearDoomsdayClock();
  }

  /**
   * Sets how a target feels about the caller.
   *
   * Relations are a -100..100 score internally, but nothing exposes that raw
   * value: `relation()` and `allRelationsSorted()` both return the derived
   * four-value Relation enum, and updateRelation only takes a delta. So the
   * score is first driven to the floor with an oversized negative delta (which
   * updateRelation clamps to -100), then raised by the wanted amount. Two
   * clamped deltas land on an exact value without ever reading it.
   */
  private setRelation(): void {
    const target = this.target();
    if (target === null || target === this.player) return;
    const wanted = this.params.amount;
    if (wanted === undefined || !Number.isFinite(wanted)) {
      console.warn(`admin cheat set_relation: bad amount ${wanted}`);
      return;
    }
    const clamped = Math.max(-100, Math.min(100, wanted));
    target.updateRelation(this.player, -1000);
    target.updateRelation(this.player, clamped + 100);
  }

  /** Moves a target's entire gold balance to the caller. */
  private stealGold(): void {
    const target = this.target();
    if (target === null || target === this.player) return;
    const taken = target.removeGold(target.gold());
    if (taken > 0n) this.player.addGold(taken);
  }

  /** Marks a target as a traitor, as breaking an alliance would. */
  private markTraitor(): void {
    const target = this.target();
    if (target === null || target === this.player) return;
    target.markTraitor();
  }

  // -------------------------------------------------------------------------
  // Giving
  //
  // The mirror of the taking actions above. Same target resolution, same
  // validation — an admin running an event or compensating a player should not
  // have to reach for a worse-behaved code path than the punitive one.
  // -------------------------------------------------------------------------

  /** Grants gold to a target out of thin air; the caller pays nothing. */
  private giftGold(): void {
    const target = this.target();
    const amount = this.amount();
    if (target === null || amount === null) return;
    target.addGold(toInt(amount));
  }

  private giftTroops(): void {
    const target = this.target();
    const amount = this.amount();
    if (target === null || amount === null) return;
    target.addTroops(amount);
  }

  /** Toggles a target's immunity — a shield for someone being spawn-camped. */
  private giftGodMode(): void {
    const target = this.target();
    if (target === null) return;
    target.setAdminGodMode(this.params.enabled === true);
  }

  /**
   * Brings an eliminated player back by handing them territory around the
   * selected tile.
   *
   * There is no separate "dead" flag to clear: isAlive() is simply
   * tiles.size > 0, so giving land IS the revival. The tiles come from the
   * caller's own conquest of them being reversed — target.conquer() takes them
   * from whoever holds them now, which is how a normal capture works too.
   */
  private revivePlayer(): void {
    const target = this.target();
    if (target === null) return;
    if (target === this.player) return;
    if (target.isAlive()) {
      console.warn("admin cheat revive_player: target is already alive");
      return;
    }

    const tile = this.params.tile;
    if (tile === undefined || !this.mg.isValidRef(tile)) {
      console.warn(`admin cheat revive_player: invalid tile ${tile}`);
      return;
    }
    if (!this.mg.isLand(tile)) {
      console.warn("admin cheat revive_player: not a land tile");
      return;
    }

    // A single tile technically revives them but leaves them instantly dead
    // again to the first attacker, so give a small contiguous pocket. Capped
    // low: this is a rescue, not a gift of the map.
    const radius = Math.min(Math.floor(this.params.amount ?? 3), 10);
    const seen = new Set<TileRef>([tile]);
    let frontier: TileRef[] = [tile];
    for (let step = 0; step <= radius && frontier.length > 0; step++) {
      const next: TileRef[] = [];
      for (const current of frontier) {
        if (this.mg.isLand(current) && this.mg.owner(current) !== target) {
          target.conquer(current);
        }
        for (const neighbor of this.mg.neighbors(current)) {
          if (seen.has(neighbor) || !this.mg.isLand(neighbor)) continue;
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
    }

    // Without troops the revived player cannot hold or expand from the pocket.
    if (target.troops() <= 0) {
      target.addTroops(this.mg.config().maxTroops(target) / 10);
    }
  }

  /**
   * Builds a unit for a target at the selected tile, covering the cost.
   *
   * Delegates to ConstructionExecution exactly as spawn_unit does, so every
   * per-type rule (nuke trajectories, warship patrol tiles, placement
   * validity) still applies — the gift is the cost, not the rules.
   */
  private giftUnit(): void {
    const target = this.target();
    if (target === null) return;
    const { unitType, tile } = this.params;
    if (unitType === undefined) {
      console.warn("admin cheat gift_unit: no unit type");
      return;
    }
    if (tile === undefined || !this.mg.isValidRef(tile)) {
      console.warn(`admin cheat gift_unit: invalid tile ${tile}`);
      return;
    }
    if (this.mg.config().isUnitDisabled(unitType)) {
      console.warn(`admin cheat gift_unit: ${unitType} is disabled`);
      return;
    }

    const cost = this.mg.unitInfo(unitType).cost(this.mg, target);
    if (cost > 0n) target.addGold(cost);
    this.mg.addExecution(new ConstructionExecution(target, unitType, tile));
  }

  /**
   * Clears a target's traitor mark and doomsday clock — the counterpart to
   * mark_traitor, for undoing a punishment or a mistake.
   */
  private pardonPlayer(): void {
    const target = this.target();
    if (target === null) return;
    (target as unknown as { markedTraitorTick: number }).markedTraitorTick = -1;
    target.clearDoomsdayClock();
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
