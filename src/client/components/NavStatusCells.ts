import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { UserMeResponse } from "../../core/ApiSchemas";
import { PublicGames } from "../../core/Schemas";
import { hasLinkedAccount } from "../Api";
import { translateText } from "../Utils";

/**
 * Live status cells on the right of the top bar: how many players are in
 * public lobbies, and the signed-in player's credit balance. The rank lives
 * in the commander rail, where it has room to mean something.
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
    const signedIn =
      hasLinkedAccount(this.userMeResponse) && this.userMeResponse !== false;
    const credits = signedIn
      ? ((this.userMeResponse as UserMeResponse).player?.credits ?? 0)
      : null;

    return html`
      ${waiting !== null
        ? html`<div class="lt-nav-cell cursor-default">
            <span class="lt-label !text-[13px]"
              >${translateText("host_modal.players")}</span
            >
            <span class="lt-num text-[15px]">${waiting}</span>
          </div>`
        : nothing}
      ${credits !== null
        ? html`<div
            class="lt-nav-cell cursor-default relative"
            translate="no"
            title=${translateText("main.coming_soon")}
          >
            <!-- Dimmed like Store/Clans: the balance is real, but there is
                 nothing to spend it on yet. The chip stays full-opacity. -->
            <span class="flex items-center gap-2 opacity-40">
              <svg
                viewBox="0 0 24 24"
                class="w-[18px] h-[18px] text-lt-400"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path
                  d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.6h-3a1.8 1.8 0 0 0 0 3.6h4"
                />
              </svg>
              <span class="lt-label !text-[13px]"
                >${translateText("nav.credits")}</span
              >
              <span class="lt-num text-[15px] text-lt-100"
                >${credits.toLocaleString("en-US")}</span
              >
            </span>
            <span
              class="absolute top-2 right-0 lt-num text-[10px] font-bold uppercase tracking-[0.08em] bg-lt-accent text-lt-accent-ink px-1.5 leading-[16px] pointer-events-none"
              >${translateText("main.soon")}</span
            >
          </div>`
        : nothing}
    `;
  }
}
