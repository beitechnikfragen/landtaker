import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { UserMeResponse } from "../../core/ApiSchemas";
import { PublicGames } from "../../core/Schemas";
import { hasLinkedAccount } from "../Api";
import { translateText } from "../Utils";
import "./RankBadge";
import { rankFromElo } from "./RankBadge";

/**
 * Live status cells on the right of the top bar: how many players are in
 * public lobbies, and the signed-in player's rank.
 *
 * Split out of DesktopNavBar so the bar stays markup and this holds the two
 * subscriptions. Each cell renders only when it has real data — an empty
 * counter is worse than no counter.
 */
@customElement("nav-status-cells")
export class NavStatusCells extends LitElement {
  @state() private lobbies: PublicGames | null = null;
  @state() private userMeResponse: UserMeResponse | false = false;

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
    super.disconnectedCallback();
  }

  private onLobbies = (e: CustomEvent<{ payload: PublicGames }>) => {
    this.lobbies = e.detail?.payload ?? null;
  };

  private onUserMe = (e: CustomEvent<UserMeResponse | false>) => {
    this.userMeResponse = e.detail;
  };

  private playersWaiting(): number | null {
    if (this.lobbies === null) return null;
    return Object.values(this.lobbies.games ?? {})
      .flat()
      .reduce((sum, lobby) => sum + (lobby.numClients ?? 0), 0);
  }

  render() {
    const waiting = this.playersWaiting();
    const elo =
      hasLinkedAccount(this.userMeResponse) && this.userMeResponse !== false
        ? this.userMeResponse.player?.leaderboard?.oneVone?.elo
        : undefined;
    const hasElo = typeof elo === "number" && Number.isFinite(elo);

    return html`
      ${waiting !== null
        ? html`<div class="lt-nav-cell cursor-default">
            <span class="lt-label !text-[13px]"
              >${translateText("host_modal.players")}</span
            >
            <span class="lt-num text-[15px]">${waiting}</span>
          </div>`
        : nothing}
      ${hasElo
        ? html`<div class="lt-nav-cell cursor-default">
            <rank-badge .elo=${elo} .size=${24}></rank-badge>
            <span class="lt-label !text-[13px] !text-lt-100"
              >${rankFromElo(elo).label}</span
            >
          </div>`
        : nothing}
    `;
  }
}
