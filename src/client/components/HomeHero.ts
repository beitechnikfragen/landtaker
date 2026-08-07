import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { UserMeResponse } from "../../core/ApiSchemas";
import { GameMapType } from "../../core/game/Game";
import { PublicGameInfo, PublicGames } from "../../core/Schemas";
import { hasLinkedAccount } from "../Api";
import {
  calculateServerTimeOffset,
  getMapName,
  getSecondsUntilServerTimestamp,
  translateText,
} from "../Utils";
import "./RankBadge";

/**
 * The top of the play page: the mark and live server state on the left, the
 * player's own standing on the right.
 *
 * Everything here is real: the counts come from the public-lobby socket that
 * game-mode-selector already listens to, and the rail is driven by the same
 * userMeResponse event the rest of the app uses. There is deliberately no
 * marketing copy — a live "next match in 0:42" sells the game better than a
 * tagline, and it needs no new translations.
 *
 * The rail renders only for signed-in players. For everyone else there is no
 * rank, rating or match history to show, so it collapses and the hero takes
 * the full width rather than leaving an empty panel.
 */
@customElement("home-hero")
export class HomeHero extends LitElement {
  @state() private lobbies: PublicGames | null = null;
  @state() private userMeResponse: UserMeResponse | false = false;
  /** Ticks once a second so the countdown stays live between socket pushes. */
  @state() private now = Date.now();

  private clock: ReturnType<typeof setInterval> | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(
      "public-lobbies-update",
      this.onLobbies as EventListener,
    );
    document.addEventListener("userMeResponse", this.onUserMe as EventListener);
    this.clock = setInterval(() => (this.now = Date.now()), 1000);
  }

  disconnectedCallback() {
    document.removeEventListener(
      "public-lobbies-update",
      this.onLobbies as EventListener,
    );
    document.removeEventListener(
      "userMeResponse",
      this.onUserMe as EventListener,
    );
    if (this.clock !== null) clearInterval(this.clock);
    super.disconnectedCallback();
  }

  private onLobbies = (e: CustomEvent<{ payload: PublicGames }>) => {
    this.lobbies = e.detail?.payload ?? null;
  };

  private onUserMe = (e: CustomEvent<UserMeResponse | false>) => {
    this.userMeResponse = e.detail;
  };

  /** Players sitting in public lobbies right now. */
  private playersWaiting(): number | null {
    if (this.lobbies === null) return null;
    return Object.values(this.lobbies.games ?? {})
      .flat()
      .reduce((sum, lobby) => sum + (lobby.numClients ?? 0), 0);
  }

  /** Seconds until the soonest public lobby starts. */
  private nextStartSeconds(): number | null {
    if (this.lobbies === null) return null;
    // getSecondsUntilServerTimestamp takes a clock OFFSET, not the server time
    // itself — passing serverTime straight in would be off by the epoch.
    const offset = calculateServerTimeOffset(this.lobbies.serverTime, this.now);
    const times = Object.values(this.lobbies.games ?? {})
      .flat()
      .map((lobby) => lobby.startsAt)
      .filter((t): t is number => typeof t === "number")
      .map((t) => getSecondsUntilServerTimestamp(t, offset, this.now))
      .filter((s) => s > 0);
    return times.length === 0 ? null : Math.min(...times);
  }

  private renderStatus() {
    const waiting = this.playersWaiting();
    if (waiting === null) return nothing;

    return html`
      <div class="lt-status">
        <span>${translateText("home.servers_online")}</span>
        <span class="text-lt-600">·</span>
        <span><b>${waiting}</b> ${translateText("host_modal.players")}</span>
      </div>
    `;
  }

  private renderRail() {
    // No linked account means no rank, rating or history — the whole rail
    // would be placeholders, so it does not render at all.
    if (!hasLinkedAccount(this.userMeResponse) || this.userMeResponse === false)
      return nothing;

    const player = this.userMeResponse.player;
    const board = player?.leaderboard;
    const elo1v1 = board?.oneVone?.elo;
    const hasElo = typeof elo1v1 === "number" && Number.isFinite(elo1v1);
    const record = board?.oneVone;
    const matches = player?.recentMatches ?? [];

    return html`
      <aside class="lt-rail flex flex-col min-w-0">
        <div class="lt-rail-h">${translateText("main.account")}</div>
        <div class="p-4">
          ${hasElo
            ? html`<rank-badge
                  .elo=${elo1v1}
                  .size=${52}
                  .showLabel=${true}
                  .showProgress=${true}
                  class="block mb-4"
                ></rank-badge>
                <div class="lt-kv">
                  <span>${translateText("player_stats_tree.stats_wins")}</span>
                  <b class="text-lt-ok">${record?.wins ?? 0}</b>
                </div>
                <div class="lt-kv">
                  <span
                    >${translateText("player_stats_tree.stats_losses")}</span
                  >
                  <b class="text-lt-bad">${record?.losses ?? 0}</b>
                </div>`
            : html`<div class="lt-label !text-[12px] !text-lt-500">
                ${translateText("matchmaking_modal.no_elo")}
              </div>`}
        </div>
        ${matches.length > 0
          ? html`
              <div class="lt-rail-h border-t border-lt-700">
                ${translateText("clan_modal.tab_game_history")}
              </div>
              <div class="py-1">
                ${matches.map(
                  (match) => html`
                    <div
                      class="lt-row flex items-center gap-3 px-4 py-2 text-[13px]"
                    >
                      <!-- Placement carries the result: first place is the
                           only one worth colouring. -->
                      <i
                        class="lt-num not-italic min-w-[26px] h-[20px] grid place-items-center border text-[12px] ${match.placement ===
                        1
                          ? "bg-lt-accent text-lt-accent-ink border-lt-accent"
                          : "text-lt-400 border-lt-600"}"
                        >${match.placement ?? "—"}</i
                      >
                      <span class="flex-1 min-w-0 truncate text-lt-100"
                        >${match.map ?? "—"}</span
                      >
                      <span class="lt-label !text-[12px] !text-lt-500 shrink-0"
                        >${match.mode ?? ""}</span
                      >
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
      </aside>
    `;
  }

  /**
   * The primary actions live in the hero, not under the lobby cards: this is
   * the first thing on the page, so the thing a player came to do belongs
   * here. They open the same modals game-mode-selector does.
   */
  private open(selector: string) {
    return () => {
      const modal = document.querySelector(selector) as {
        open?: () => void;
      } | null;
      modal?.open?.();
    };
  }

  /** The FFA lobby the Deploy button joins — the one starting soonest. */
  private deployLobby(): PublicGameInfo | null {
    const ffa = this.lobbies?.games?.["ffa"] ?? [];
    if (ffa.length === 0) return null;
    const offset = calculateServerTimeOffset(
      this.lobbies!.serverTime,
      this.now,
    );
    const upcoming = ffa
      .filter((lobby) => typeof lobby.startsAt === "number")
      .map((lobby) => ({
        lobby,
        seconds: getSecondsUntilServerTimestamp(
          lobby.startsAt!,
          offset,
          this.now,
        ),
      }))
      .filter((entry) => entry.seconds > 0)
      .sort((a, b) => a.seconds - b.seconds)[0];
    return upcoming?.lobby ?? ffa[0] ?? null;
  }

  /**
   * Joins the soonest public FFA lobby — the same join-lobby event the lobby
   * cards dispatch. FFA carries no playerTeams, so the party-fit guard the
   * cards run has nothing to check here.
   */
  private deploy = () => {
    const usernameInput = document.querySelector("username-input") as {
      canPlay?: () => boolean;
    } | null;
    if (usernameInput?.canPlay && !usernameInput.canPlay()) return;
    const lobby = this.deployLobby();
    if (!lobby) return;
    this.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: lobby.gameID,
          source: "public",
          publicLobbyInfo: lobby,
        },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private renderActions() {
    const deployTarget = this.deployLobby();
    const deploySub =
      deployTarget?.gameConfig?.gameMap !== undefined
        ? `${getMapName(deployTarget.gameConfig.gameMap as GameMapType)}`
        : null;

    return html`
      <div class="lt-rise">
        <div class="lt-group w-fit">
          <button
            class="lt-btn lt-btn-primary"
            ?disabled=${deployTarget === null}
            @click=${this.deploy}
          >
            ${translateText("home.deploy")}
            <small class="lt-btn-sub">${deploySub ?? "—"}</small>
          </button>
          <button class="lt-btn" @click=${this.open("single-player-modal")}>
            ${translateText("home.single_player")}
            <small class="lt-btn-sub">${translateText("home.no_queue")}</small>
          </button>
          <button class="lt-btn" @click=${this.open("host-lobby-modal")}>
            ${translateText("main.create")}
            <small class="lt-btn-sub"
              >${translateText("home.private_lobby")}</small
            >
          </button>
          <button class="lt-btn" @click=${this.open("join-lobby-modal")}>
            ${translateText("main.join")}
            <small class="lt-btn-sub">${translateText("home.by_invite")}</small>
          </button>
        </div>
        ${this.renderDeployLine()}
      </div>
    `;
  }

  /** "Next deployment in 0:42 · 46 of 64 slots filled" — all live data. */
  private renderDeployLine() {
    const seconds = this.nextStartSeconds();
    const slots = this.nextLobbySlots();
    if (seconds === null && slots === null) return nothing;

    const mmss =
      seconds === null
        ? null
        : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

    return html`
      <div
        class="lt-label !text-[13px] !text-lt-500 mt-3 flex items-center gap-2"
      >
        ${mmss !== null
          ? html`<span
                >${translateText("home.next_deployment", { time: "" })}</span
              ><b class="lt-num text-lt-accent text-[14px]">${mmss}</b>`
          : nothing}
        ${mmss !== null && slots !== null
          ? html`<span class="text-lt-600">·</span>`
          : nothing}
        ${slots !== null
          ? html`<span
              >${translateText("home.slots_filled", {
                filled: String(slots.filled),
                max: String(slots.max),
              })}</span
            >`
          : nothing}
      </div>
    `;
  }

  /** Fill of the lobby that starts soonest — "46 of 64 slots filled". */
  private nextLobbySlots(): { filled: number; max: number } | null {
    if (this.lobbies === null) return null;
    const offset = calculateServerTimeOffset(this.lobbies.serverTime, this.now);
    const upcoming = Object.values(this.lobbies.games ?? {})
      .flat()
      .filter((lobby) => typeof lobby.startsAt === "number")
      .map((lobby) => ({
        lobby,
        seconds: getSecondsUntilServerTimestamp(
          lobby.startsAt!,
          offset,
          this.now,
        ),
      }))
      .filter((entry) => entry.seconds > 0)
      .sort((a, b) => a.seconds - b.seconds)[0];

    const max = upcoming?.lobby.gameConfig?.maxPlayers;
    if (!upcoming || typeof max !== "number") return null;
    return { filled: upcoming.lobby.numClients ?? 0, max };
  }

  render() {
    // 1:1 with the mock's hero: status tag, the two-line display headline
    // (second line receding), the lede, then the action group. The wordmark
    // lives in the nav — the headline IS the hero.
    return html`
      <div class="lt-home border border-lt-700 bg-lt-900/55 backdrop-blur-sm">
        <div
          class="flex flex-col justify-center gap-5 px-6 py-9 lg:px-10 lg:py-12"
        >
          ${this.renderStatus()}
          <h1
            class="lt-display !font-semibold leading-[0.9] text-[clamp(42px,5.4vw,76px)] text-lt-100 lt-rise"
          >
            ${translateText("home.hero_title_1")}<br />
            <span class="text-lt-500 !font-light"
              >${translateText("home.hero_title_2")}</span
            >
          </h1>
          <p
            class="max-w-[46ch] text-[14px] leading-relaxed text-lt-400 lt-rise"
          >
            ${translateText("home.hero_lede")}
          </p>
          ${this.renderActions()}
        </div>
        ${this.renderRail()}
      </div>
    `;
  }
}
