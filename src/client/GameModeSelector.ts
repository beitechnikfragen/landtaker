import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ClientEnv } from "src/client/ClientEnv";
import { UserMeResponse } from "../core/ApiSchemas";
import {
  Duos,
  GameMapType,
  GameMode,
  HumansVsNations,
  Quads,
  Trios,
} from "../core/game/Game";
import { PublicGameInfo, PublicGames } from "../core/Schemas";
import { hasLinkedAccount } from "./Api";
import "./components/IOSAddToHomeScreenBanner";
import { rankBadgeUrl, rankFromElo } from "./components/RankBadge";
import { HostLobbyModal } from "./HostLobbyModal";
import { showInGameAlert } from "./InGameModal";
import { JoinLobbyModal } from "./JoinLobbyModal";
import { PublicLobbySocket } from "./LobbySocket";
import { JoinLobbyEvent } from "./Main";
import { fetchPartyFit } from "./PartyApi";
import { SinglePlayerModal } from "./SinglePlayerModal";
import { terrainMapFileLoader } from "./TerrainMapFileLoader";
import { UsernameInput } from "./UsernameInput";
import {
  calculateServerTimeOffset,
  getMapName,
  getModifierLabels,
  getSecondsUntilServerTimestamp,
  renderDuration,
  translateText,
} from "./Utils";

const CARD_BG = "";

@customElement("game-mode-selector")
export class GameModeSelector extends LitElement {
  @state() private lobbies: PublicGames | null = null;
  @state() private mapAspectRatios: Map<GameMapType, number> = new Map();
  @state() private inputValid: boolean = true;
  @state() private userMeResponse: UserMeResponse | false = false;
  private serverTimeOffset: number = 0;
  private defaultLobbyTime: number = 0;

  private lobbySocket = new PublicLobbySocket((lobbies) =>
    this.handleLobbiesUpdate(lobbies),
  );

  createRenderRoot() {
    return this;
  }

  /**
   * Refuses the join when the player's party is larger than a team in this
   * lobby, and says why. Catching it here means nobody gets kicked or split
   * once the match has started.
   *
   * Free-for-all lobbies carry no `playerTeams`, so there is nothing to check.
   * Everything else — no party, signed out, backend unreachable — fails open
   * inside fetchPartyFit: a failed side request must never block a join.
   */
  private async validatePartyFits(lobby: PublicGameInfo): Promise<boolean> {
    const teamCount = lobby.gameConfig?.playerTeams;

    // Free-for-all: parties join freely. There are no teams to seat them in,
    // and friends squadding up in FFA happens anyway — warning about it just
    // added a click.
    if (teamCount === undefined) return true;

    const fit = await fetchPartyFit(teamCount);
    if (fit.fits) return true;

    await showInGameAlert(
      translateText("party.lobby_too_small", {
        partySize: String(fit.partySize),
        seats: String(fit.seats ?? 0),
      }),
    );
    return false;
  }

  // Silent backstop; the buttons are already disabled while input is invalid.
  private validateUsername(): boolean {
    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    return usernameInput ? usernameInput.canPlay() : true;
  }

  private onUserMe = (e: CustomEvent<UserMeResponse | false>) => {
    this.userMeResponse = e.detail;
  };

  connectedCallback() {
    super.connectedCallback();
    this.lobbySocket.start();
    this.defaultLobbyTime = ClientEnv.gameCreationRate() / 1000;
    window.addEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );
    document.addEventListener("userMeResponse", this.onUserMe as EventListener);
    // Pick up the current value in case username-input validated before us.
    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    if (usernameInput) {
      this.inputValid = usernameInput.canPlay();
    }
  }

  disconnectedCallback() {
    this.stop();
    window.removeEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );
    document.removeEventListener(
      "userMeResponse",
      this.onUserMe as EventListener,
    );
    super.disconnectedCallback();
  }

  private handleValidityChange = (e: Event) => {
    this.inputValid = (e as CustomEvent).detail?.isValid ?? true;
  };

  public stop() {
    this.lobbySocket.stop();
  }

  private handleLobbiesUpdate(lobbies: PublicGames) {
    this.lobbies = lobbies;
    this.serverTimeOffset = calculateServerTimeOffset(lobbies.serverTime);
    document.dispatchEvent(
      new CustomEvent("public-lobbies-update", {
        detail: { payload: lobbies },
      }),
    );
    this.requestUpdate();

    const allGames = Object.values(lobbies.games ?? {}).flat();
    for (const game of allGames) {
      const mapType = game.gameConfig?.gameMap as GameMapType;
      if (mapType && !this.mapAspectRatios.has(mapType)) {
        // New Map reference triggers Lit reactivity; placeholder ratio 1 lets
        // has() guard against duplicate in-flight fetches.
        this.mapAspectRatios = new Map(this.mapAspectRatios).set(mapType, 1);
        terrainMapFileLoader
          .getMapData(mapType)
          .manifest()
          .then((m: any) => {
            if (m?.map?.width && m?.map?.height) {
              this.mapAspectRatios = new Map(this.mapAspectRatios).set(
                mapType,
                m.map.width / m.map.height,
              );
            }
          })
          .catch((e) =>
            console.error(`Failed to load manifest for ${mapType}`, e),
          );
      }
    }
  }

  render() {
    const ffa = this.lobbies?.games?.["ffa"]?.[0];
    const teams = this.lobbies?.games?.["team"]?.[0];
    const special = this.lobbies?.games?.["special"]?.[0];

    return html`
      <div class="flex flex-col gap-4 w-full px-4 sm:px-0 mx-auto pb-4 sm:pb-0">
        <!-- Solo: mobile only, top -->
        <div class="sm:hidden h-14">
          ${this.renderSmallActionCard(
            translateText("main.solo"),
            this.openSinglePlayerModal,
            "lt-btn-primary",
          )}
        </div>
        <!-- Create/ranked/join: mobile only, below solo -->
        <div class="sm:hidden grid grid-cols-3 gap-4 h-14">
          ${this.renderSmallActionCard(
            translateText("main.create"),
            this.openHostLobby,
            "",
          )}
          ${this.renderSmallActionCard(
            translateText("mode_selector.ranked_title"),
            this.openRankedMenu,
            "",
          )}
          ${this.renderSmallActionCard(
            translateText("main.join"),
            this.openJoinLobby,
            "",
            this.hostedLobbyCount(),
          )}
        </div>
        <!-- iOS Add to Home Screen banner -->
        <ios-add-to-home-screen-banner
          class="no-crazygames"
        ></ios-add-to-home-screen-banner>

        <!-- Section rule above the cards, as in the mock: DEPLOYMENTS ——— -->
        <div class="hidden sm:flex lt-rule">
          <h2 class="lt-label !text-[14px] !text-lt-400">
            ${translateText("home.deployments")}
          </h2>
        </div>

        <!-- Game cards grid -->
        ${this.lobbies === null
          ? html`<div
              class="flex items-center justify-center h-44 sm:h-[clamp(20rem,42vh,30rem)]"
            >
              <span
                class="w-16 h-16 border-4 border-lt-700 border-t-lt-accent rounded-full animate-spin"
              ></span>
            </div>`
          : html`<div
              class="grid grid-cols-1 sm:grid-cols-[1.75fr_1fr] gap-3 sm:h-[clamp(20rem,42vh,30rem)]"
            >
              <!-- Left col: main card (desktop only) -->
              ${ffa
                ? html`<div class="hidden sm:block">
                    ${this.renderLobbyCard(ffa, this.getLobbyTitle(ffa), true)}
                  </div>`
                : nothing}

              <!-- Right col: special + teams (desktop only) -->
              <div class="hidden sm:flex sm:flex-col sm:gap-3">
                ${special
                  ? html`<div class="flex-1 min-h-0">
                      ${this.renderSpecialLobbyCard(special)}
                    </div>`
                  : nothing}
                ${teams
                  ? html`<div class="flex-1 min-h-0">
                      ${this.renderLobbyCard(teams, this.getLobbyTitle(teams))}
                    </div>`
                  : nothing}
              </div>

              <!-- Mobile: special, ffa, teams inline -->
              <div class="sm:hidden">
                ${special ? this.renderSpecialLobbyCard(special) : nothing}
              </div>
              <div class="sm:hidden">
                ${ffa
                  ? this.renderLobbyCard(ffa, this.getLobbyTitle(ffa))
                  : nothing}
              </div>
              <div class="sm:hidden">
                ${teams
                  ? this.renderLobbyCard(teams, this.getLobbyTitle(teams))
                  : nothing}
              </div>
            </div>`}

        <!-- Below the cards, mock layout: every remaining open lobby in a
             table on the left, the player's ranked standing on the right.
             Desktop only — mobile keeps the compact action cards above. -->
        ${this.lobbies !== null
          ? html`<div class="hidden sm:grid grid-cols-[1.75fr_1fr] gap-3">
              ${this.renderOpenLobbies([ffa, teams, special])}
              ${this.renderRankedPanel()}
            </div>`
          : nothing}
      </div>
    `;
  }

  /** Lobbies that did not get a card, as the mock's OPEN LOBBIES table. */
  private renderOpenLobbies(shown: (PublicGameInfo | undefined)[]) {
    const shownIds = new Set(
      shown
        .filter((lobby): lobby is PublicGameInfo => lobby !== undefined)
        .map((lobby) => lobby.gameID),
    );
    const extra = Object.values(this.lobbies?.games ?? {})
      .flat()
      .filter((lobby) => !shownIds.has(lobby.gameID));

    return html`
      <!-- Fixed height on purpose: the set of open lobbies changes every
           cycle, and letting the panel grow and shrink with it made the whole
           band below breathe. Overflow scrolls inside instead. -->
      <div
        class="border border-lt-700 bg-[rgb(13_16_20/0.85)] h-[300px] flex flex-col"
      >
        <div
          class="flex items-center justify-between px-4 py-2 border-b border-lt-700 shrink-0"
        >
          <span class="lt-label !text-[12px]"
            >${translateText("home.open_lobbies")}</span
          >
        </div>
        ${extra.length === 0
          ? html`<div class="px-4 py-5 lt-label !text-[11px] !text-lt-500">
              ${translateText("home.no_open_lobbies")}
            </div>`
          : html`
              <div
                class="grid grid-cols-[minmax(0,2fr)_1fr_auto_auto] items-center gap-x-6 px-4 py-1.5 border-b border-lt-700/60 shrink-0"
              >
                <span class="lt-label !text-[10px]"
                  >${translateText("home.col_map")}</span
                >
                <span class="lt-label !text-[10px]"
                  >${translateText("host_modal.mode")}</span
                >
                <span class="lt-label !text-[10px] text-right"
                  >${translateText("host_modal.players")}</span
                >
                <span class="lt-label !text-[10px] text-right"
                  >${translateText("home.starts")}</span
                >
              </div>
              <div class="flex-1 overflow-y-auto min-h-0">
                ${extra.map((lobby) => this.renderLobbyRow(lobby))}
              </div>
            `}
      </div>
    `;
  }

  private renderLobbyRow(lobby: PublicGameInfo) {
    const mapType = lobby.gameConfig!.gameMap as GameMapType;
    const thumb = terrainMapFileLoader.getMapData(mapType).webpPath;
    const seconds = lobby.startsAt
      ? getSecondsUntilServerTimestamp(lobby.startsAt, this.serverTimeOffset)
      : null;

    return html`
      <button
        @click=${() => void this.validateAndJoin(lobby)}
        ?disabled=${!this.inputValid}
        class="grid grid-cols-[minmax(0,2fr)_1fr_auto_auto] items-center gap-x-6 w-full px-4 py-2 text-left lt-row cursor-pointer"
      >
        <span class="flex items-center gap-3 min-w-0">
          ${thumb
            ? html`<img
                src=${thumb}
                alt=""
                class="w-[52px] h-[36px] object-cover border border-lt-700 shrink-0"
              />`
            : nothing}
          <span class="text-[14px] font-bold text-lt-100 truncate"
            >${getMapName(lobby.gameConfig?.gameMap) ?? "—"}</span
          >
        </span>
        <span class="lt-label !text-[11px] truncate"
          >${this.getLobbyTitle(lobby)}</span
        >
        <span class="lt-num text-[13px] text-right text-lt-100"
          >${lobby.numClients} / ${lobby.gameConfig?.maxPlayers ?? "—"}</span
        >
        <span class="lt-num text-[13px] text-right text-lt-400"
          >${seconds !== null && seconds > 0
            ? renderDuration(seconds)
            : translateText("public_lobby.starting_game")}</span
        >
      </button>
    `;
  }

  /** The mock's SEASON panel, driven by the player's real ranked record. */
  private renderRankedPanel() {
    const board =
      this.userMeResponse !== false && hasLinkedAccount(this.userMeResponse)
        ? this.userMeResponse.player?.leaderboard
        : undefined;
    const elo = board?.oneVone?.elo;
    const hasElo = typeof elo === "number" && Number.isFinite(elo);
    const rank = hasElo ? rankFromElo(elo) : null;

    return html`
      <div
        class="border border-lt-700 bg-[rgb(13_16_20/0.85)] flex flex-col self-start"
      >
        <div
          class="flex items-center justify-between px-4 py-2 border-b border-lt-700"
        >
          <span class="lt-label !text-[12px]"
            >${translateText("mode_selector.ranked_title")}</span
          >
          <button
            @click=${this.openRankedMenu}
            class="lt-label !text-[11px] hover:!text-lt-accent transition-colors cursor-pointer"
          >
            ${translateText("home.details")}
          </button>
        </div>
        ${rank !== null
          ? html`
              <div class="lt-kv !px-4">
                <span>${translateText("home.placement")}</span>
                <b class="flex items-center gap-2">
                  <img
                    src=${rankBadgeUrl(rank, true)}
                    alt=""
                    aria-hidden="true"
                    class="w-[22px] h-[22px]"
                  />
                  ${rank.label}
                </b>
              </div>
              ${rank.toNext !== null
                ? html`<div class="lt-kv !px-4">
                    <span>${translateText("rank.next_rank")}</span>
                    <b class="text-lt-accent">+${rank.toNext}</b>
                  </div>`
                : nothing}
              <div class="lt-kv !px-4">
                <span>${translateText("player_stats_tree.stats_wins")}</span>
                <b class="text-lt-ok">${board?.oneVone?.wins ?? 0}</b>
              </div>
              <div class="lt-kv !px-4">
                <span>${translateText("rank.matches")}</span>
                <b
                  >${(board?.oneVone?.wins ?? 0) +
                  (board?.oneVone?.losses ?? 0)}</b
                >
              </div>
            `
          : html`
              <div class="px-4 py-3 lt-label !text-[11px] !text-lt-500">
                ${translateText("matchmaking_modal.no_elo")}
              </div>
              <div class="px-4 pb-3">
                <button
                  @click=${this.openRankedMenu}
                  ?disabled=${!this.inputValid}
                  class="lt-btn w-full py-2"
                >
                  ${translateText("mode_selector.ranked_title")}
                </button>
              </div>
            `}
      </div>
    `;
  }

  private renderSpecialLobbyCard(lobby: PublicGameInfo) {
    return this.renderLobbyCard(lobby, this.getLobbyTitle(lobby));
  }

  private openRankedMenu = () => {
    if (!this.validateUsername()) return;
    window.showPage?.("page-ranked");
  };

  private openSinglePlayerModal = () => {
    if (!this.validateUsername()) return;
    (
      document.querySelector("single-player-modal") as SinglePlayerModal
    )?.open();
  };

  private openHostLobby = () => {
    if (!this.validateUsername()) return;
    (document.querySelector("host-lobby-modal") as HostLobbyModal)?.open();
  };

  private openJoinLobby = () => {
    if (!this.validateUsername()) return;
    (document.querySelector("join-lobby-modal") as JoinLobbyModal)?.open();
  };

  // Number of open hosted lobbies waiting in the browser; shown as a chip
  // on the Join button.
  private hostedLobbyCount(): number {
    return this.lobbies?.games?.hosted?.length ?? 0;
  }

  private renderSmallActionCard(
    title: string,
    onClick: () => void,
    bgClass: string = CARD_BG,
    badge?: number,
  ) {
    return html`
      <button
        @click=${onClick}
        ?disabled=${!this.inputValid}
        class="lt-btn relative flex items-center justify-center w-full h-full ${bgClass} ${!this
          .inputValid
          ? "pointer-events-none"
          : ""}"
      >
        ${title}
        ${badge
          ? html`<span
              class="lt-num absolute top-1.5 right-1.5 min-w-[20px] h-[18px] px-1 flex items-center justify-center bg-lt-accent text-lt-accent-ink text-[12px]"
              >${badge}</span
            >`
          : nothing}
      </button>
    `;
  }

  private renderLobbyCard(
    lobby: PublicGameInfo,
    titleContent: string | TemplateResult,
    featured = false,
  ) {
    const mapType = lobby.gameConfig!.gameMap as GameMapType;
    const mapImageSrc = terrainMapFileLoader.getMapData(mapType).webpPath;
    const aspectRatio = this.mapAspectRatios.get(mapType);
    // Use object-contain for extreme aspect ratios (e.g. Amazon River ~20:1) so
    // the full map is visible instead of being cropped by object-cover.
    const useContain =
      aspectRatio !== undefined && (aspectRatio > 4 || aspectRatio < 0.25);
    const timeRemaining = lobby.startsAt
      ? getSecondsUntilServerTimestamp(lobby.startsAt, this.serverTimeOffset)
      : undefined;

    let timeDisplay: string;
    let timeDisplayUppercase = false;
    if (timeRemaining === undefined) {
      timeDisplay = renderDuration(this.defaultLobbyTime);
    } else if (timeRemaining > 0) {
      timeDisplay = renderDuration(timeRemaining);
    } else {
      timeDisplay = translateText("public_lobby.starting_game");
      timeDisplayUppercase = true;
    }

    const mapName = getMapName(lobby.gameConfig?.gameMap);

    const modifierLabels = getModifierLabels(
      lobby.gameConfig?.publicGameModifiers,
      lobby.gameConfig?.doomsdayClock?.speed,
    );
    // Sort by length for visual consistency (shorter labels first)
    if (modifierLabels.length > 1) {
      modifierLabels.sort((a, b) => a.length - b.length);
    }

    const maxPlayers = lobby.gameConfig?.maxPlayers ?? 0;
    const fillPercent =
      maxPlayers > 0
        ? Math.min(
            100,
            Math.round(((lobby.numClients ?? 0) / maxPlayers) * 100),
          )
        : 0;

    return html`
      <button
        @click=${() => void this.validateAndJoin(lobby)}
        ?disabled=${!this.inputValid}
        class="group relative w-full h-44 sm:h-full text-lt-100 uppercase border ${featured
          ? "border-lt-accent"
          : "border-lt-700 hover:border-lt-accent"} transition-colors duration-150 bg-lt-800 overflow-hidden ${!this
          .inputValid
          ? "opacity-50 cursor-not-allowed pointer-events-none"
          : ""}"
      >
        <!-- Image clipped separately so overflow-hidden doesn't block absolute children -->
        <div class="absolute inset-0 overflow-hidden pointer-events-none">
          ${mapImageSrc
            ? html`<img
                src="${mapImageSrc}"
                alt="${mapName ?? lobby.gameConfig?.gameMap ?? "map"}"
                draggable="false"
                class="absolute inset-0 w-full h-full ${useContain
                  ? "object-contain"
                  : "object-cover object-center scale-[1.05]"} [image-rendering:auto]"
              />`
            : null}
        </div>
        <!-- Top row: mode chip + modifiers left, countdown right -->
        <div
          class="absolute inset-x-2 top-2 flex items-start justify-between gap-2"
        >
          <div class="flex flex-col items-start gap-1 mt-[2px]">
            <span
              class="lt-label !text-[12px] !text-lt-900 px-2 py-1 bg-lt-100 border border-lt-100"
              >${titleContent}</span
            >
            ${modifierLabels.map(
              (label) =>
                html`<span
                  class="lt-label !text-[12px] !text-lt-accent px-2 py-1 bg-lt-900/85 border border-lt-accent/45"
                  >${label}</span
                >`,
            )}
          </div>
          <div class="shrink-0">
            <span
              class="lt-num text-[14px] ${timeDisplayUppercase
                ? "uppercase"
                : "normal-case"} bg-lt-accent text-lt-accent-ink px-2 py-1"
              >${timeDisplay}</span
            >
          </div>
        </div>
        <!-- Bottom block, mock order: map name, mode sub, fill underline,
             then players left / JOIN right. -->
        <div
          class="absolute bottom-0 left-0 right-0 flex flex-col px-3 pt-6 pb-2 text-left bg-gradient-to-t from-lt-900/95 via-lt-900/70 to-transparent"
        >
          ${mapName
            ? html`<span
                class="lt-display ${featured
                  ? "text-[24px]"
                  : "text-[17px]"} leading-none"
                >${mapName}</span
              >`
            : ""}
          <!-- Sub-line carries what the chip doesn't: modifiers when there
               are any, otherwise nothing (the chip already names the mode). -->
          ${modifierLabels.length > 0
            ? html`<span class="lt-label !text-[11px] mt-1"
                >${modifierLabels.join(" · ")}</span
              >`
            : nothing}
          <div class="h-[2px] bg-lt-700/80 mt-2">
            <div
              class="h-full bg-lt-accent"
              style="width: ${fillPercent}%"
            ></div>
          </div>
          <div class="flex items-center justify-between mt-1.5">
            <span class="lt-num flex items-center gap-1.5 text-[13px]">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="h-3.5 w-3.5 inline-block"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
              >
                <path d="M16 21v-2a4 4 0 0 0-8 0v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              ${lobby.numClients} / ${maxPlayers}
            </span>
            <span
              class="lt-label !text-[12px] group-hover:!text-lt-accent transition-colors"
              >${translateText("home.join")}
              <span aria-hidden="true">→</span></span
            >
          </div>
        </div>
      </button>
    `;
  }

  private async validateAndJoin(lobby: PublicGameInfo) {
    if (!this.validateUsername()) return;
    if (!(await this.validatePartyFits(lobby))) return;

    this.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: lobby.gameID,
          source: "public",
          publicLobbyInfo: lobby,
        } as JoinLobbyEvent,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private getLobbyTitle(lobby: PublicGameInfo): string {
    const config = lobby.gameConfig!;
    if (config.gameMode === GameMode.FFA) {
      return translateText("game_mode.ffa");
    }

    if (config?.gameMode === GameMode.Team) {
      const totalPlayers = config.maxPlayers ?? lobby.numClients ?? undefined;
      const formatTeamsOf = (
        teamCount: number | undefined,
        playersPerTeam: number | undefined,
        label?: string,
      ) => {
        if (!teamCount)
          return label ?? translateText("mode_selector.teams_title");
        const baseTitle = playersPerTeam
          ? translateText("mode_selector.teams_of", {
              teamCount: String(teamCount),
              playersPerTeam: String(playersPerTeam),
            })
          : translateText("mode_selector.teams_count", {
              teamCount: String(teamCount),
            });
        return `${baseTitle}${label ? ` (${label})` : ""}`;
      };

      switch (config.playerTeams) {
        case Duos: {
          const teamCount = totalPlayers
            ? Math.floor(totalPlayers / 2)
            : undefined;
          return formatTeamsOf(teamCount, 2);
        }
        case Trios: {
          const teamCount = totalPlayers
            ? Math.floor(totalPlayers / 3)
            : undefined;
          return formatTeamsOf(teamCount, 3);
        }
        case Quads: {
          const teamCount = totalPlayers
            ? Math.floor(totalPlayers / 4)
            : undefined;
          return formatTeamsOf(teamCount, 4);
        }
        case HumansVsNations: {
          const humanSlots = config.maxPlayers ?? lobby.numClients;
          return humanSlots
            ? translateText("public_lobby.teams_hvn_detailed", {
                num: String(humanSlots),
              })
            : translateText("public_lobby.teams_hvn");
        }
        default:
          if (typeof config.playerTeams === "number") {
            const teamCount = config.playerTeams;
            const playersPerTeam =
              totalPlayers && teamCount > 0
                ? Math.floor(totalPlayers / teamCount)
                : undefined;
            return formatTeamsOf(teamCount, playersPerTeam);
          }
      }
    }

    return "";
  }
}
