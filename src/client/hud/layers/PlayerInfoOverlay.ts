import { html, LitElement, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { assetUrl } from "../../../core/AssetUrls";
import { EventBus } from "../../../core/EventBus";
import {
  PlayerProfile,
  PlayerType,
  Relation,
  Unit,
  UnitType,
} from "../../../core/game/Game";
import { TileRef } from "../../../core/game/GameMap";
import { AllianceView } from "../../../core/game/GameUpdates";
import { Controller } from "../../Controller";
import {
  ContextMenuEvent,
  MouseMoveEvent,
  TouchEvent,
} from "../../InputHandler";
import { themeProvider } from "../../theme/ThemeProvider";
import { TransformHandler } from "../../TransformHandler";
import {
  getTranslatedPlayerTeamLabel,
  renderDuration,
  renderNumber,
  renderTroops,
  translateText,
} from "../../Utils";
import { GameView, PlayerView, UnitView } from "../../view";
import {
  EMOJI_ICON_KIND,
  getFirstPlacePlayer,
  getPlayerIcons,
  IMAGE_ICON_KIND,
} from "../PlayerIcons";
import { ImmunityBarVisibleEvent } from "./ImmunityTimer";
import { CloseRadialMenuEvent } from "./RadialMenu";
import "./RelationSmiley";
import { SpawnBarVisibleEvent } from "./SpawnTimer";
const allianceIcon = assetUrl("images/AllianceIcon.svg");
const traitorIcon = assetUrl("images/TraitorIcon.svg");
const warshipIcon = assetUrl("images/BattleshipIconWhite.svg");
const cityIcon = assetUrl("images/CityIconWhite.svg");
const factoryIcon = assetUrl("images/FactoryIconWhite.svg");
const missileSiloIcon = assetUrl("images/MissileSiloIconWhite.svg");
const portIcon = assetUrl("images/PortIcon.svg");
const samLauncherIcon = assetUrl("images/SamLauncherIconWhite.svg");

function euclideanDistWorld(
  coord: { x: number; y: number },
  tileRef: TileRef,
  game: GameView,
): number {
  const x = game.x(tileRef);
  const y = game.y(tileRef);
  const dx = coord.x - x;
  const dy = coord.y - y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distSortUnitWorld(coord: { x: number; y: number }, game: GameView) {
  return (a: Unit | UnitView, b: Unit | UnitView) => {
    const distA = euclideanDistWorld(coord, a.tile(), game);
    const distB = euclideanDistWorld(coord, b.tile(), game);
    return distA - distB;
  };
}

@customElement("player-info-overlay")
export class PlayerInfoOverlay extends LitElement implements Controller {
  @property({ type: Object })
  public game!: GameView;

  @property({ type: Object })
  public eventBus!: EventBus;

  @property({ type: Object })
  public transform!: TransformHandler;

  @state()
  private player: PlayerView | null = null;

  @state()
  private playerProfile: PlayerProfile | null = null;

  @state()
  private unit: UnitView | null = null;

  @state()
  private _isInfoVisible: boolean = false;

  @state()
  private spawnBarVisible = false;
  @state()
  private immunityBarVisible = false;

  private _isActive = false;

  private get barOffset(): number {
    return (this.spawnBarVisible ? 7 : 0) + (this.immunityBarVisible ? 7 : 0);
  }

  private lastMouseUpdate = 0;

  init() {
    this.eventBus.on(MouseMoveEvent, (e: MouseMoveEvent) =>
      this.onMouseEvent(e),
    );
    this.eventBus.on(ContextMenuEvent, (e: ContextMenuEvent) =>
      this.maybeShow(e.x, e.y),
    );
    this.eventBus.on(TouchEvent, (e: TouchEvent) => this.maybeShow(e.x, e.y));
    this.eventBus.on(CloseRadialMenuEvent, () => this.hide());
    this.eventBus.on(SpawnBarVisibleEvent, (e) => {
      this.spawnBarVisible = e.visible;
    });
    this.eventBus.on(ImmunityBarVisibleEvent, (e) => {
      this.immunityBarVisible = e.visible;
    });
    this._isActive = true;
  }

  private onMouseEvent(event: MouseMoveEvent) {
    const now = Date.now();
    if (now - this.lastMouseUpdate < 100) {
      return;
    }
    this.lastMouseUpdate = now;
    this.maybeShow(event.x, event.y);
  }

  public hide() {
    this.setVisible(false);
    this.unit = null;
    this.player = null;
  }

  public maybeShow(x: number, y: number) {
    this.hide();
    const worldCoord = this.transform.screenToWorldCoordinates(x, y);
    if (!this.game.isValidCoord(worldCoord.x, worldCoord.y)) {
      return;
    }

    const tile = this.game.ref(worldCoord.x, worldCoord.y);
    if (!tile) return;

    const owner = this.game.owner(tile);

    if (owner && owner.isPlayer()) {
      this.player = owner as PlayerView;
      this.player.profile().then((p) => {
        this.playerProfile = p;
      });
      this.setVisible(true);
    } else if (!this.game.isLand(tile)) {
      const units = this.game
        .units(UnitType.Warship, UnitType.TradeShip, UnitType.TransportShip)
        .filter((u) => euclideanDistWorld(worldCoord, u.tile(), this.game) < 50)
        .sort(distSortUnitWorld(worldCoord, this.game));

      if (units.length > 0) {
        this.unit = units[0];
        this.setVisible(true);
      }
    }
  }

  tick() {
    this.requestUpdate();
  }

  setVisible(visible: boolean) {
    this._isInfoVisible = visible;
    this.requestUpdate();
  }

  private getPlayerNameColor(isFriendly: boolean): string {
    if (isFriendly) return "text-green-500";
    return "text-white";
  }

  private getRelationSmiley(
    player: PlayerView,
    myPlayer: PlayerView | null | undefined,
  ): TemplateResult | string {
    if (!myPlayer || myPlayer === player || player.type() !== PlayerType.Nation)
      return "";
    const relation =
      this.playerProfile?.relations[myPlayer.smallID()] ?? Relation.Neutral;
    if (relation === Relation.Neutral) return "";
    return html`<relation-smiley .relation=${relation}></relation-smiley>`;
  }

  private getRelationName(relation: Relation): string {
    switch (relation) {
      case Relation.Hostile:
        return translateText("relation.hostile");
      case Relation.Distrustful:
        return translateText("relation.distrustful");
      case Relation.Neutral:
        return translateText("relation.neutral");
      case Relation.Friendly:
        return translateText("relation.friendly");
      default:
        return translateText("relation.default");
    }
  }

  private displayUnitCount(player: PlayerView, type: UnitType, icon: string) {
    return !this.game.config().isUnitDisabled(type)
      ? html`<span class="inline-flex items-center gap-1.5" translate="no">
          <img
            src=${icon}
            class="w-3.5 h-3.5 object-contain shrink-0 opacity-70"
          />
          <span>${player.totalUnitLevels(type)}</span>
        </span>`
      : "";
  }

  private allianceExpirationText(alliance: AllianceView) {
    const { expiresAt } = alliance;
    const remainingTicks = expiresAt - this.game.ticks();
    let remainingSeconds = 0;
    if (remainingTicks > 0) {
      remainingSeconds = Math.max(0, Math.floor(remainingTicks / 10)); // 10 ticks per second
    }
    return renderDuration(remainingSeconds);
  }

  private renderPlayerNameIcons(player: PlayerView) {
    const firstPlace = getFirstPlacePlayer(this.game);
    const icons = getPlayerIcons({
      game: this.game,
      player,
      firstPlace,
    });

    if (icons.length === 0) {
      return html``;
    }

    return html`<span class="flex items-center gap-1 shrink-0">
      ${icons.map((icon) =>
        icon.kind === EMOJI_ICON_KIND && icon.text
          ? html`<span class="text-sm shrink-0" translate="no"
              >${icon.text}</span
            >`
          : icon.kind === IMAGE_ICON_KIND && icon.src
            ? html`<img src=${icon.src} alt="" class="w-4 h-4 shrink-0" />`
            : html``,
      )}
    </span>`;
  }

  /** The relation chip at the header's right edge: one word, one colour. */
  private renderRelationChip(
    player: PlayerView,
    myPlayer: PlayerView | null,
  ): TemplateResult | "" {
    if (!myPlayer || myPlayer === player) return "";

    const traitorTicks = player.getTraitorRemainingTicks();
    if (traitorTicks > 0) {
      return html`<span
        class="ml-auto shrink-0 flex items-center gap-1 lt-label !text-[11px] !text-lt-bad border border-lt-bad/45 px-2 py-0.5"
        translate="no"
      >
        <img src=${traitorIcon} alt="" class="w-3.5 h-3.5" />
        ${renderDuration(Math.floor(traitorTicks / 10))}
      </span>`;
    }

    if (myPlayer.isAlliedWith(player)) {
      const alliance = myPlayer
        .alliances()
        .find((a) => a.other === player.id());
      return html`<span
        class="ml-auto shrink-0 flex items-center gap-1 lt-label !text-[11px] !text-lt-ok border border-lt-ok/45 px-2 py-0.5"
        translate="no"
      >
        <img src=${allianceIcon} alt="" class="w-3.5 h-3.5" />
        ${alliance !== undefined ? this.allianceExpirationText(alliance) : ""}
      </span>`;
    }

    if (player.type() === PlayerType.Nation) {
      const relation =
        this.playerProfile?.relations[myPlayer.smallID()] ?? Relation.Neutral;
      if (relation === Relation.Neutral) return "";
      const tone =
        relation === Relation.Hostile
          ? "!text-lt-bad border-lt-bad/45"
          : relation === Relation.Distrustful
            ? "!text-lt-gold border-lt-gold/45"
            : "!text-lt-ok border-lt-ok/45";
      return html`<span
        class="ml-auto shrink-0 lt-label !text-[11px] ${tone} border px-2 py-0.5"
        >${this.getRelationName(relation)}</span
      >`;
    }

    return "";
  }

  private renderStatCell(label: string, value: string, valueClass = "") {
    return html`<div class="bg-[rgb(20_24_28/0.96)] px-3 py-1.5">
      <span class="lt-label !text-[10px] block">${label}</span>
      <span class="text-base font-bold tabular-nums leading-tight ${valueClass}"
        >${value}</span
      >
    </div>`;
  }

  private renderPlayerInfo(player: PlayerView) {
    const myPlayer = this.game.myPlayer();
    const isFriendly = myPlayer?.isFriendly(player);
    const attackingTroops = player
      .outgoingAttacks()
      .map((a) => a.troops)
      .reduce((a, b) => a + b, 0);

    let playerType = "";
    switch (player.type()) {
      case PlayerType.Bot:
        playerType = translateText("player_type.bot");
        break;
      case PlayerType.Nation:
        playerType = translateText("player_type.nation");
        break;
      case PlayerType.Human:
        playerType = translateText("player_type.player");
        break;
    }
    const playerTeam = getTranslatedPlayerTeamLabel(player.team());

    const validTiles = Math.max(
      this.game.numLandTiles() - this.game.numTilesWithFallout(),
      1,
    );
    const landPercent = (player.numTilesOwned() / validTiles) * 100;
    const landText =
      landPercent >= 10 ? landPercent.toFixed(0) : landPercent.toFixed(1);

    return html`
      <!-- Header: flag · name · kind · relation chip -->
      <div class="flex items-center gap-2.5 px-3 py-2 border-b border-lt-700">
        ${player.cosmetics.flag
          ? html`<img
              class="h-[17px] w-[26px] object-cover border border-lt-600 shrink-0"
              src=${assetUrl(player.cosmetics.flag!)}
            />`
          : html``}
        <span
          class="font-[family-name:var(--font-lt-display)] font-semibold uppercase tracking-[0.04em] text-[17px] leading-none truncate ${this.getPlayerNameColor(
            isFriendly ?? false,
          )}"
          >${player.displayName()}</span
        >
        <span class="lt-label !text-[11px] shrink-0">${playerType}</span>
        ${playerTeam !== "" && player.type() !== PlayerType.Bot
          ? html`<span
              class="lt-label !text-[11px] shrink-0"
              style="color: ${themeProvider
                .current()
                .teamColor(player.team()!)
                .toHex()}"
              >${playerTeam}</span
            >`
          : html``}
        ${this.getRelationSmiley(player, myPlayer)}
        ${this.renderPlayerNameIcons(player)}
        ${this.renderRelationChip(player, myPlayer)}
      </div>
      <!-- Stat grid: troops / gold / land / attacking -->
      <div class="grid grid-cols-4 gap-px bg-lt-700" translate="no">
        ${this.renderStatCell(
          translateText("player_panel.troops"),
          renderTroops(player.troops()),
          "text-lt-100",
        )}
        ${this.renderStatCell(
          translateText("player_panel.gold"),
          renderNumber(player.gold()),
          "text-lt-gold",
        )}
        ${this.renderStatCell(
          translateText("player_panel.land"),
          `${landText}%`,
          "text-lt-100",
        )}
        ${this.renderStatCell(
          translateText("player_panel.attacking"),
          renderTroops(attackingTroops),
          attackingTroops > 0 ? "text-lt-accent" : "text-lt-500",
        )}
      </div>
      <!-- Structures strip -->
      <div
        class="flex items-center gap-3.5 px-3 py-1.5 border-t border-lt-700 text-lt-400 text-xs tabular-nums"
      >
        ${this.displayUnitCount(player, UnitType.City, cityIcon)}
        ${this.displayUnitCount(player, UnitType.Factory, factoryIcon)}
        ${this.displayUnitCount(player, UnitType.Port, portIcon)}
        ${this.displayUnitCount(player, UnitType.MissileSilo, missileSiloIcon)}
        ${this.displayUnitCount(player, UnitType.SAMLauncher, samLauncherIcon)}
        ${this.displayUnitCount(player, UnitType.Warship, warshipIcon)}
      </div>
    `;
  }

  private renderUnitInfo(unit: UnitView) {
    const isAlly =
      (unit.owner() === this.game.myPlayer() ||
        this.game.myPlayer()?.isFriendly(unit.owner())) ??
      false;

    return html`
      <div class="p-2">
        <div class="font-bold mb-1 ${isAlly ? "text-green-500" : "text-white"}">
          ${unit.owner().displayName()}
        </div>
        <div class="mt-1">
          <div class="text-sm opacity-80">${unit.type()}</div>
          ${unit.hasHealth()
            ? html` <div class="text-sm">Health: ${unit.health()}</div> `
            : ""}
          ${unit.type() === UnitType.TransportShip
            ? html`
                <div class="text-sm">
                  Troops: ${renderTroops(unit.troops())}
                </div>
              `
            : ""}
        </div>
      </div>
    `;
  }

  render() {
    if (!this._isActive) {
      return html``;
    }

    const containerClasses = this._isInfoVisible
      ? "opacity-100 visible"
      : "opacity-0 invisible pointer-events-none";

    return html`
      <div
        class="fixed top-0 left-0 right-0 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-[1001]"
        style="margin-top: ${this.barOffset}px;"
        @click=${() => this.hide()}
        @contextmenu=${(e: MouseEvent) => e.preventDefault()}
      >
        <div
          class="bg-[rgb(11_14_17/0.92)] border border-lt-700 backdrop-blur-sm text-white text-base w-full sm:w-auto sm:min-w-[392px] sm:max-w-[560px] overflow-hidden ${containerClasses}"
        >
          ${this.player !== null ? this.renderPlayerInfo(this.player) : ""}
          ${this.unit !== null ? this.renderUnitInfo(this.unit) : ""}
        </div>
      </div>
    `;
  }

  createRenderRoot() {
    return this; // Disable shadow DOM to allow Tailwind styles
  }
}
