import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { UserMeResponse } from "../../core/ApiSchemas";
import { assetUrl } from "../../core/AssetUrls";
import { PublicGames } from "../../core/Schemas";
import { hasLinkedAccount } from "../Api";
import {
  calculateServerTimeOffset,
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
    const next = this.nextStartSeconds();
    if (waiting === null) return nothing;

    const mmss =
      next === null
        ? null
        : `${Math.floor(next / 60)}:${String(next % 60).padStart(2, "0")}`;

    return html`
      <div class="lt-status">
        <span><b>${waiting}</b> ${translateText("host_modal.players")}</span>
        ${mmss !== null
          ? html`<span class="text-lt-600">·</span> <span><b>${mmss}</b></span>`
          : nothing}
      </div>
    `;
  }

  private renderRail() {
    // No linked account means no rank, rating or history — the whole rail
    // would be placeholders, so it does not render at all.
    if (!hasLinkedAccount(this.userMeResponse) || this.userMeResponse === false)
      return nothing;

    // UserMeResponse carries elo per queue, but no win/loss totals — so the
    // rail shows the two ratings it can actually source rather than inventing
    // a stat block.
    const board = this.userMeResponse.player?.leaderboard;
    const elo1v1 = board?.oneVone?.elo;
    const elo2v2 = board?.twoVtwo?.elo;
    const hasElo = typeof elo1v1 === "number" && Number.isFinite(elo1v1);

    return html`
      <aside class="lt-rail flex flex-col">
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
                  <span
                    >${translateText("mode_selector.ranked_1v1_title")}</span
                  >
                  <b class="text-lt-accent">${elo1v1}</b>
                </div>`
            : html`<div class="lt-label !text-[12px] !text-lt-500">
                ${translateText("matchmaking_modal.no_elo")}
              </div>`}
          ${typeof elo2v2 === "number" && Number.isFinite(elo2v2)
            ? html`<div class="lt-kv">
                <span>${translateText("mode_selector.ranked_2v2_title")}</span>
                <b>${elo2v2}</b>
              </div>`
            : nothing}
        </div>
      </aside>
    `;
  }

  render() {
    return html`
      <div class="lt-home border border-lt-700 bg-lt-900/55 backdrop-blur-sm">
        <div class="flex flex-col justify-center gap-5 px-6 py-8 lg:px-8">
          ${this.renderStatus()}
          <img
            src=${assetUrl("images/LandtakerLogoDark.svg")}
            alt="Landtaker"
            class="block w-full max-w-[420px] aspect-[1364/259] lt-rise"
          />
        </div>
        ${this.renderRail()}
      </div>
    `;
  }
}
