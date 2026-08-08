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
 * Tile-dependent cheats use the tile last right-clicked on the map, shown in
 * the panel so it is never a mystery which tile an action will hit. Silent by
 * design: nothing is announced to other players.
 */

/**
 * Shared control styles.
 *
 * `[&>option]` is the load-bearing part: a <select> only styles its own box,
 * while the popup list is drawn by the OS and defaults to a white background.
 * Without an explicit option background the white text here rendered
 * white-on-white and the dropdowns were unreadable.
 */
const FIELD =
  "w-full rounded border border-lt-600 bg-lt-800 px-2 py-1 text-sm text-white " +
  "placeholder:text-lt-500 focus:border-red-500/70 focus:outline-none";
const SELECT = `${FIELD} [&>option]:bg-lt-800 [&>option]:text-white`;
const BTN =
  "rounded bg-lt-700 px-2 py-1 text-xs text-white hover:bg-lt-600 " +
  "disabled:cursor-not-allowed disabled:opacity-40";
const BTN_DANGER =
  "rounded bg-red-800 px-2 py-1 text-xs text-white hover:bg-red-700 " +
  "disabled:cursor-not-allowed disabled:opacity-40";

type Section = "resources" | "build" | "self" | "players";

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
  @state() private radius = "5";
  @state() private relation = "100";
  @state() private unitType: UnitType = UnitType.City;
  @state() private godMode = false;
  @state() private lastAction: string | null = null;
  // Sections are collapsible because the action list outgrew one screen; only
  // one is open at a time so the panel never scrolls past the map.
  @state() private section: Section | null = "resources";

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

  // ---- Rendering ----

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
        class="fixed left-2 top-1/2 z-[210] flex max-h-[85vh] w-72 -translate-y-1/2 flex-col rounded border border-red-500/60 bg-black/90 text-white backdrop-blur"
      >
        <div
          class="flex shrink-0 items-center justify-between border-b border-lt-700 px-3 py-2"
        >
          <span class="text-xs font-bold uppercase tracking-widest text-red-400"
            >${translateText("admin_cheat.title")}</span
          >
          <button
            class="px-1 text-lt-400 hover:text-white"
            title=${translateText("admin_cheat.close")}
            @click=${() => {
              this.open = false;
            }}
          >
            ✕
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          ${this.renderTileRow()}
          ${this.renderSection(
            "resources",
            translateText("admin_cheat.sec_resources"),
            () => this.renderResources(),
          )}
          ${this.renderSection(
            "build",
            translateText("admin_cheat.sec_build"),
            () => this.renderBuild(),
          )}
          ${this.renderSection(
            "self",
            translateText("admin_cheat.sec_self"),
            () => this.renderSelf(),
          )}
          ${this.renderSection(
            "players",
            translateText("admin_cheat.sec_players"),
            () => this.renderPlayerActions(),
          )}
        </div>

        ${this.renderStatus()}
      </div>
    `;
  }

  /** One collapsible section. Clicking a closed header closes the open one. */
  private renderSection(
    key: Section,
    label: string,
    body: () => TemplateResult,
  ): TemplateResult {
    const isOpen = this.section === key;
    return html`
      <div class="mb-2 rounded border border-lt-700">
        <button
          class="flex w-full items-center justify-between px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-lt-300 hover:bg-lt-800"
          @click=${() => {
            this.section = isOpen ? null : key;
          }}
        >
          <span>${label}</span>
          <span class="text-lt-500">${isOpen ? "−" : "+"}</span>
        </button>
        ${isOpen
          ? html`<div class="border-t border-lt-700 p-2">${body()}</div>`
          : null}
      </div>
    `;
  }

  private renderTileRow(): TemplateResult {
    const has = this.selectedTile !== null;
    return html`
      <div
        class="mb-2 rounded border ${has
          ? "border-green-600/60"
          : "border-lt-700"} px-2 py-1 text-xs"
      >
        <div class="text-lt-400">${translateText("admin_cheat.tile")}</div>
        <div class="font-mono ${has ? "text-green-400" : "text-lt-500"}">
          ${has
            ? `${this.game.x(this.selectedTile!)}, ${this.game.y(this.selectedTile!)}`
            : translateText("admin_cheat.no_tile")}
        </div>
      </div>
    `;
  }

  /** Label + input + buttons, the shape most cheats need. */
  private field(
    label: string,
    value: string,
    onInput: (v: string) => void,
    actions: Array<[string, () => void, boolean?]>,
  ): TemplateResult {
    return html`
      <div class="mb-2">
        <label class="mb-1 block text-xs text-lt-400">${label}</label>
        <input
          type="number"
          class="${FIELD} mb-1"
          .value=${value}
          @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
        />
        <div class="flex flex-wrap gap-1">
          ${actions.map(
            ([text, run, danger]) => html`
              <button class="${danger ? BTN_DANGER : BTN} flex-1" @click=${run}>
                ${text}
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderResources(): TemplateResult {
    return html`
      ${this.field(
        translateText("admin_cheat.gold"),
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
      ${this.field(
        translateText("admin_cheat.troops"),
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
      <button class="${BTN} w-full" @click=${() => this.send("max_troops")}>
        ${translateText("admin_cheat.max_troops")}
      </button>
    `;
  }

  private renderBuild(): TemplateResult {
    const noTile = this.selectedTile === null;
    return html`
      <div class="mb-2">
        <label class="mb-1 block text-xs text-lt-400"
          >${translateText("admin_cheat.spawn_unit")}</label
        >
        <select
          class="${SELECT} mb-1"
          .value=${this.unitType}
          @change=${(e: Event) => {
            this.unitType = (e.target as HTMLSelectElement).value as UnitType;
          }}
        >
          ${Object.values(UnitType).map(
            (type) => html`<option value=${type}>${type}</option>`,
          )}
        </select>
        <button
          class="${BTN} w-full"
          ?disabled=${noTile}
          @click=${() =>
            this.send("spawn_unit", {
              unitType: this.unitType,
              tile: this.selectedTile,
            })}
        >
          ${translateText("admin_cheat.place")}
        </button>
      </div>

      ${this.field(
        translateText("admin_cheat.radius"),
        this.radius,
        (v) => {
          this.radius = v;
        },
        [
          [
            translateText("admin_cheat.capture_radius"),
            () => {
              const amount = this.parseAmount(this.radius);
              if (amount !== null && !noTile) {
                this.send("capture_radius", {
                  amount,
                  tile: this.selectedTile,
                });
              }
            },
          ],
        ],
      )}

      <div class="flex flex-col gap-1">
        <button
          class="${BTN}"
          ?disabled=${noTile}
          @click=${() => this.send("capture_tile", { tile: this.selectedTile })}
        >
          ${translateText("admin_cheat.capture")}
        </button>
        <button class="${BTN}" @click=${() => this.send("upgrade_structures")}>
          ${translateText("admin_cheat.upgrade_all")}
        </button>
        <button class="${BTN_DANGER}" @click=${() => this.send("clear_units")}>
          ${translateText("admin_cheat.clear_units")}
        </button>
      </div>
    `;
  }

  private renderSelf(): TemplateResult {
    return html`
      <div class="flex flex-col gap-1">
        <button
          class="w-full rounded px-2 py-1 text-xs text-white ${this.godMode
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
        <button class="${BTN}" @click=${() => this.send("clear_traitor")}>
          ${translateText("admin_cheat.clear_traitor")}
        </button>
        <button class="${BTN}" @click=${() => this.send("clear_doomsday")}>
          ${translateText("admin_cheat.clear_doomsday")}
        </button>
      </div>
    `;
  }

  private renderPlayerActions(): TemplateResult {
    const players = this.otherPlayers();
    if (players.length === 0) {
      return html`<div class="text-xs text-lt-500">
        ${translateText("admin_cheat.no_players")}
      </div>`;
    }

    const noTarget = this.targetPlayerID === null;
    const act =
      (action: AdminCheatAction, extra: object = {}) =>
      () => {
        if (this.targetPlayerID === null) return;
        this.send(action, { targetID: this.targetPlayerID, ...extra });
      };

    return html`
      <label class="mb-1 block text-xs text-lt-400"
        >${translateText("admin_cheat.target")}</label
      >
      <select
        class="${SELECT} mb-2"
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

      <div class="mb-2 flex flex-col gap-1">
        <button
          class="${BTN}"
          ?disabled=${noTarget}
          @click=${act("force_alliance")}
        >
          ${translateText("admin_cheat.force_alliance")}
        </button>
        <button
          class="${BTN}"
          ?disabled=${noTarget}
          @click=${act("break_alliance")}
        >
          ${translateText("admin_cheat.break_alliance")}
        </button>
        <button
          class="${BTN}"
          ?disabled=${noTarget}
          @click=${act("steal_gold")}
        >
          ${translateText("admin_cheat.steal_gold")}
        </button>
        <button
          class="${BTN}"
          ?disabled=${noTarget}
          @click=${act("mark_traitor")}
        >
          ${translateText("admin_cheat.mark_traitor")}
        </button>
        <button
          class="${BTN_DANGER}"
          ?disabled=${noTarget}
          @click=${act("kill_player")}
        >
          ${translateText("admin_cheat.kill")}
        </button>
      </div>

      <label class="mb-1 block text-xs text-lt-400"
        >${translateText("admin_cheat.relation")}</label
      >
      <div class="flex gap-1">
        <input
          type="number"
          min="-100"
          max="100"
          class="${FIELD} flex-1"
          .value=${this.relation}
          @input=${(e: Event) => {
            this.relation = (e.target as HTMLInputElement).value;
          }}
        />
        <button
          class="${BTN}"
          ?disabled=${noTarget}
          @click=${() => {
            const amount = Number(this.relation);
            if (!Number.isFinite(amount)) return;
            act("set_relation", { amount })();
          }}
        >
          ${translateText("admin_cheat.set")}
        </button>
      </div>
    `;
  }

  private renderStatus(): TemplateResult | null {
    if (this.lastAction === null) return null;
    return html`<div
      class="shrink-0 border-t border-lt-700 px-3 py-1 text-center text-[10px] text-lt-500"
    >
      ${translateText("admin_cheat.sent")}: ${this.lastAction}
    </div>`;
  }
}
