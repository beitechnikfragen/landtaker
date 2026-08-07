import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { UserMeResponse } from "../../core/ApiSchemas";
import { getUserMe, hasLinkedAccount } from "../Api";
import { userAuth } from "../Auth";
import { crazyGamesSDK } from "../CrazyGamesSDK";
import { translateText } from "../Utils";
import { BaseModal } from "./BaseModal";
import "./RankBadge";
import { rankFromElo } from "./RankBadge";
import { modalHeader } from "./ui/ModalHeader";

@customElement("ranked-modal")
export class RankedModal extends BaseModal {
  protected routerName = "ranked";

  @state() private elo: number | string = "...";
  @state() private elo2v2: number | string = "...";
  @state() private userMeResponse: UserMeResponse | false = false;
  @state() private errorMessage: string | null = null;
  // CrazyGames players authenticate through the SDK, not a linked
  // Discord/Google/email account, so track that separately for ranked.
  @state() private crazyGamesSignedIn = false;

  // Eligible to see/play ranked: a linked account or a signed-in CrazyGames one.
  private isRankedEligible(): boolean {
    return hasLinkedAccount(this.userMeResponse) || this.crazyGamesSignedIn;
  }

  constructor() {
    super();
    this.id = "page-ranked";
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(
      "userMeResponse",
      this.handleUserMeResponse as EventListener,
    );
  }

  disconnectedCallback() {
    document.removeEventListener(
      "userMeResponse",
      this.handleUserMeResponse as EventListener,
    );
    super.disconnectedCallback();
  }

  private handleUserMeResponse = (
    event: CustomEvent<UserMeResponse | false>,
  ) => {
    this.errorMessage = null;
    this.userMeResponse = event.detail;
    this.updateElo();
  };

  private updateElo() {
    if (this.errorMessage) {
      this.elo = translateText("map_component.error");
      this.elo2v2 = translateText("map_component.error");
      return;
    }

    if (this.isRankedEligible()) {
      const leaderboard = this.userMeResponse
        ? this.userMeResponse.player.leaderboard
        : undefined;
      const noElo = translateText("matchmaking_modal.no_elo");
      this.elo = leaderboard?.oneVone?.elo ?? noElo;
      this.elo2v2 = leaderboard?.twoVtwo?.elo ?? noElo;
    }
  }

  protected override async onOpen(): Promise<void> {
    this.elo = "...";
    this.elo2v2 = "...";
    this.errorMessage = null;

    try {
      const userMe = await getUserMe();
      this.userMeResponse = userMe;
      this.crazyGamesSignedIn =
        crazyGamesSDK.isOnCrazyGames() &&
        (await crazyGamesSDK.getUserProfile()) !== null;
    } catch (error) {
      console.error("Failed to fetch user profile for ranked modal", error);
      this.userMeResponse = false;
      this.errorMessage = translateText("map_component.error");
      this.elo = translateText("map_component.error");
      this.elo2v2 = translateText("map_component.error");
    } finally {
      this.updateElo();
    }
  }

  createRenderRoot() {
    return this;
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("mode_selector.ranked_title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    return html`
      <div class="custom-scrollbar p-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          ${this.renderCard(
            translateText("mode_selector.ranked_1v1_title"),
            this.errorMessage ??
              (this.isRankedEligible()
                ? translateText("matchmaking_modal.elo", { elo: this.elo })
                : translateText("mode_selector.ranked_title")),
            () => this.handleRanked("1v1"),
            this.elo,
          )}
          ${this.renderCard(
            translateText("mode_selector.ranked_2v2_title"),
            this.errorMessage ??
              (this.isRankedEligible()
                ? translateText("matchmaking_modal.elo", { elo: this.elo2v2 })
                : translateText("mode_selector.ranked_title")),
            () => this.handleRanked("2v2"),
            this.elo2v2,
          )}
          ${this.renderDisabledCard(
            translateText("mode_selector.coming_soon"),
            "",
          )}
          ${this.renderDisabledCard(
            translateText("mode_selector.coming_soon"),
            "",
          )}
        </div>
        <p class="mt-6 text-xs text-lt-400 leading-relaxed text-center">
          ${translateText("mode_selector.ranked_pairing_note")}
        </p>
      </div>
    `;
  }

  private renderCard(
    title: string,
    subtitle: string,
    onClick: () => void,
    elo?: number | string,
  ) {
    // The badge only appears once there is a real rating to derive it from —
    // "...", "no elo" and error strings all fall through to no badge.
    const numericElo =
      typeof elo === "number" && Number.isFinite(elo) ? elo : null;

    return html`
      <button
        @click=${onClick}
        class="flex w-full h-28 sm:h-32 bg-lt-800 border border-lt-700 hover:border-lt-accent transition-colors duration-150 p-6 items-center justify-center gap-4"
      >
        ${numericElo !== null
          ? html`<rank-badge
              .elo=${numericElo}
              .size=${52}
              class="shrink-0"
            ></rank-badge>`
          : nothing}
        <div class="flex flex-col items-start gap-1 text-left min-w-0">
          <h3 class="lt-display text-lg sm:text-xl leading-tight">${title}</h3>
          <p class="lt-label !text-[12px] whitespace-pre-line leading-tight">
            ${subtitle}
          </p>
          ${numericElo !== null
            ? html`<p
                class="lt-display text-[15px] text-lt-accent leading-none"
              >
                ${rankFromElo(numericElo).label}
              </p>`
            : nothing}
        </div>
      </button>
    `;
  }

  private renderDisabledCard(title: string, subtitle: string) {
    return html`
      <div
        class="flex flex-col w-full h-28 sm:h-32 bg-lt-850 border border-lt-700 p-6 items-center justify-center gap-3 opacity-45 cursor-not-allowed"
      >
        <div class="flex flex-col items-center gap-1 text-center">
          <h3 class="lt-display text-lg sm:text-xl !text-lt-400 leading-tight">
            ${title}
          </h3>
          <p class="lt-label !text-[12px] whitespace-pre-line leading-tight">
            ${subtitle}
          </p>
        </div>
      </div>
    `;
  }

  private async handleRanked(mode: "1v1" | "2v2") {
    if ((await userAuth()) === false) {
      this.close();
      window.showPage?.("page-account");
      return;
    }

    document.dispatchEvent(
      new CustomEvent("open-matchmaking", { detail: { mode } }),
    );
  }
}
