import { html, LitElement, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { AdminCheatAction } from "../../../core/Schemas";
import { UnitType } from "../../../core/game/Game";
import { TransformHandler } from "../../TransformHandler";
import { SendAdminCheatIntentEvent } from "../../Transport";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

/**
 * In-game admin cheat menu.
 *
 * Visible only when the account holds an admin role, but that is presentation
 * only — the server refuses every cheat from a non-admin connection regardless
 * of what this component renders. See GameServer.handleIntent.
 *
 * Cheats are self-targeted except the player actions, which act on whoever is
 * selected from the live player list. Silent by design: nothing is announced
 * to other players.
 *
 * Tile-dependent cheats (spawn, capture) use the tile last clicked on the map,
 * shown in the panel so it is never a mystery which tile an action will hit.
 */
@customElement("admin-cheat-menu")
export class AdminCheatMenu extends LitElement {
  // Plain fields, not @property: GameView is the entire game state and Lit
  // should not deep-watch it. Renders are driven by @state and tick().
  public game: GameView;
  public eventBus: EventBus;
  public transformHandler: TransformHandler;

  @state() private isAdmin = false;
  @state() private open = false;
  @state() private selectedTile: number | null = null;
  @state() private targetPlayerID: string | null = null;
  @state() private goldAmount = "1000000";
  @state() private troopAmount = "100000";
  @state() private unitType: UnitType = UnitType.City;
  @state() private godMode = false;
  @state() private lastAction: string | null = null;

  createRenderRoot() {
    return this;
  }

  /** Called by GameRenderer with the role from the player's JWT claims. */
  public setRole(role: string | null): void {
    this.isAdmin = role === "admin" || role === "root";
  }

  init() {
    // The map click that picks a tile is captured at the document level rather
    // than through the game's click events: those are consumed by build menus
    // and unit selection, and the cheat menu must not compete with them.
    document.addEventListener("contextmenu", this.onMapPick);
  }

  disconnectedCallback() {
    document.removeEventListener("contextmenu", this.onMapPick);
    super.disconnectedCallback();
  }

  /**
   * Right-click while the menu is open picks the target tile. Only while open,
   * so the radial menu keeps right-click for everyone else — including admins
   * who are not currently cheating.
   */
  private onMapPick = (e: MouseEvent) => {
    if (!this.open || !this.isAdmin) return;
    const cell = this.transformHandler?.screenToWorldCoordinates(
      e.clientX,
      e.clientY,
    );
    if (!cell || !this.game.isValidCoord(cell.x, cell.y)) return;
    e.preventDefault();
    e.stopPropagation();
    this.selectedTile = this.game.ref(cell.x, cell.y);
  };

  tick() {
    // Re-render while open so the player list tracks eliminations.
    if (this.open) this.requestUpdate();
  }

  private send(action: AdminCheatAction, params: object = {}): void {
    this.eventBus.emit(new SendAdminCheatIntentEvent(action, params));
    // Cheats are silent to other players, but the operator still needs to know
    // the click registered — the effect may not be visible on screen.
    this.lastAction = action;
  }

  /** A finite, non-negative number from a text field, or null. */
  private parseAmount(raw: string): number | null {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  }

  private otherPlayers(): PlayerView[] {
    const me = this.game.myPlayer();
    return this.game
      .playerViews()
      .filter((p) => p !== me && p.isAlive())
      .sort((a, b) => a.displayName().localeCompare(b.displayName()));
  }

  render(): TemplateResult | null {
    if (!this.isAdmin) return null;

    if (!this.open) {
      return html`
        <button
          class="fixed left-2 top-1/2 z-[210] -translate-y-1/2 rounded border border-red-500/60 bg-black/70 px-2 py-3 text-xs font-bold uppercase tracking-widest text-red-400 hover:bg-black/90"
          title=${translateText("admin_cheat.open")}
          @click=${() => {
            this.open = true;
          }}
        >
          ${translateText("admin_cheat.short_label")}
        </button>
      `;
    }

    return html`
      <div
        class="fixed left-2 top-1/2 z-[210] max-h-[80vh] w-64 -translate-y-1/2 overflow-y-auto rounded border border-red-500/60 bg-black/85 p-3 text-white backdrop-blur"
      >
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-bold uppercase tracking-widest text-red-400"
            >${translateText("admin_cheat.title")}</span
          >
          <button
            class="px-2 text-lt-400 hover:text-white"
            @click=${() => {
              this.open = false;
            }}
          >
            ✕
          </button>
        </div>

        ${this.renderTileRow()} ${this.renderResources()} ${this.renderSpawn()}
        ${this.renderGodMode()} ${this.renderPlayerActions()}
        ${this.renderStatus()}
      </div>
    `;
  }

  private renderTileRow(): TemplateResult {
    return html`
      <div class="mb-3 rounded border border-lt-700 px-2 py-1 text-xs">
        <div class="text-lt-400">${translateText("admin_cheat.tile")}</div>
        <div class="font-mono">
          ${this.selectedTile === null
            ? translateText("admin_cheat.no_tile")
            : `${this.game.x(this.selectedTile)}, ${this.game.y(this.selectedTile)}`}
        </div>
      </div>
    `;
  }

  private renderResources(): TemplateResult {
    const row = (
      labelKey: string,
      value: string,
      onInput: (v: string) => void,
      actions: Array<[string, () => void]>,
    ) => html`
      <div class="mb-2">
        <label class="mb-1 block text-xs text-lt-400"
          >${translateText(labelKey)}</label
        >
        <input
          type="number"
          class="mb-1 w-full rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm"
          .value=${value}
          @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
        />
        <div class="flex gap-1">
          ${actions.map(
            ([label, run]) => html`
              <button
                class="flex-1 rounded bg-lt-700 px-2 py-1 text-xs hover:bg-lt-600"
                @click=${run}
              >
                ${label}
              </button>
            `,
          )}
        </div>
      </div>
    `;

    return html`
      ${row(
        "admin_cheat.gold",
        this.goldAmount,
        (v) => {
          this.goldAmount = v;
        },
        [
          [
            translateText("admin_cheat.give"),
            () => {
              const amount = this.parseAmount(this.goldAmount);
              if (amount !== null) this.send("give_gold", { amount });
            },
          ],
        ],
      )}
      ${row(
        "admin_cheat.troops",
        this.troopAmount,
        (v) => {
          this.troopAmount = v;
        },
        [
          [
            translateText("admin_cheat.give"),
            () => {
              const amount = this.parseAmount(this.troopAmount);
              if (amount !== null) this.send("give_troops", { amount });
            },
          ],
          [
            translateText("admin_cheat.set"),
            () => {
              const amount = this.parseAmount(this.troopAmount);
              if (amount !== null) this.send("set_troops", { amount });
            },
          ],
        ],
      )}
    `;
  }

  private renderSpawn(): TemplateResult {
    const noTile = this.selectedTile === null;
    return html`
      <div class="mb-2">
        <label class="mb-1 block text-xs text-lt-400"
          >${translateText("admin_cheat.spawn_unit")}</label
        >
        <select
          class="mb-1 w-full rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm"
          .value=${this.unitType}
          @change=${(e: Event) => {
            this.unitType = (e.target as HTMLSelectElement).value as UnitType;
          }}
        >
          ${Object.values(UnitType).map(
            (type) => html`<option value=${type}>${type}</option>`,
          )}
        </select>
        <div class="flex gap-1">
          <button
            class="flex-1 rounded bg-lt-700 px-2 py-1 text-xs hover:bg-lt-600 disabled:opacity-40"
            ?disabled=${noTile}
            @click=${() =>
              this.send("spawn_unit", {
                unitType: this.unitType,
                tile: this.selectedTile,
              })}
          >
            ${translateText("admin_cheat.place")}
          </button>
          <button
            class="flex-1 rounded bg-lt-700 px-2 py-1 text-xs hover:bg-lt-600 disabled:opacity-40"
            ?disabled=${noTile}
            @click=${() =>
              this.send("capture_tile", { tile: this.selectedTile })}
          >
            ${translateText("admin_cheat.capture")}
          </button>
        </div>
      </div>
    `;
  }

  private renderGodMode(): TemplateResult {
    return html`
      <div class="mb-2">
        <button
          class="w-full rounded px-2 py-1 text-xs ${this.godMode
            ? "bg-green-700 hover:bg-green-600"
            : "bg-lt-700 hover:bg-lt-600"}"
          @click=${() => {
            this.godMode = !this.godMode;
            this.send("god_mode", { enabled: this.godMode });
          }}
        >
          ${translateText("admin_cheat.god_mode")}:
          ${this.godMode
            ? translateText("admin_cheat.on")
            : translateText("admin_cheat.off")}
        </button>
      </div>
    `;
  }

  private renderPlayerActions(): TemplateResult {
    const players = this.otherPlayers();
    if (players.length === 0) {
      return html`<div class="mb-2 text-xs text-lt-500">
        ${translateText("admin_cheat.no_players")}
      </div>`;
    }

    const noTarget = this.targetPlayerID === null;
    const act = (action: AdminCheatAction) => () => {
      if (this.targetPlayerID === null) return;
      this.send(action, { targetID: this.targetPlayerID });
    };

    return html`
      <div class="mb-2">
        <label class="mb-1 block text-xs text-lt-400"
          >${translateText("admin_cheat.target")}</label
        >
        <select
          class="mb-1 w-full rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm"
          .value=${this.targetPlayerID ?? ""}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            this.targetPlayerID = value === "" ? null : value;
          }}
        >
          <option value="">${translateText("admin_cheat.pick_player")}</option>
          ${players.map(
            (p) => html`<option value=${p.id()}>${p.displayName()}</option>`,
          )}
        </select>
        <div class="flex flex-col gap-1">
          <button
            class="rounded bg-lt-700 px-2 py-1 text-xs hover:bg-lt-600 disabled:opacity-40"
            ?disabled=${noTarget}
            @click=${act("force_alliance")}
          >
            ${translateText("admin_cheat.force_alliance")}
          </button>
          <button
            class="rounded bg-lt-700 px-2 py-1 text-xs hover:bg-lt-600 disabled:opacity-40"
            ?disabled=${noTarget}
            @click=${act("break_alliance")}
          >
            ${translateText("admin_cheat.break_alliance")}
          </button>
          <button
            class="rounded bg-red-800 px-2 py-1 text-xs hover:bg-red-700 disabled:opacity-40"
            ?disabled=${noTarget}
            @click=${act("kill_player")}
          >
            ${translateText("admin_cheat.kill")}
          </button>
        </div>
      </div>
    `;
  }

  private renderStatus(): TemplateResult | null {
    if (this.lastAction === null) return null;
    return html`<div class="text-center text-[10px] text-lt-500">
      ${translateText("admin_cheat.sent")}: ${this.lastAction}
    </div>`;
  }
}
