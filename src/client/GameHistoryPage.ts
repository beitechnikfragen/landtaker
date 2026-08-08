import { html, LitElement, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { UserMeResponse } from "../core/ApiSchemas";
import { getUserMe } from "./Api";
import { ClientEnv } from "./ClientEnv";
import "./components/baseComponents/stats/GameHistoryMetricsHeader";
import "./components/baseComponents/stats/PlayerGameHistoryView";
import type { PlayerGameHistoryCache } from "./components/baseComponents/stats/PlayerGameHistoryView";
import { translateText } from "./Utils";

@customElement("game-history-page")
export class GameHistoryPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private publicId = "";
  @state() private historyCache: PlayerGameHistoryCache | null = null;

  connectedCallback() {
    super.connectedCallback();
    // Identity may already be known (Main fetches it at boot) or arrive later.
    document.addEventListener("userMeResponse", this.onUserMe);
    void this.loadIdentity();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("userMeResponse", this.onUserMe);
  }

  private onUserMe = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | UserMeResponse
      | false
      | undefined;
    this.applyPublicId(
      detail === false || detail === undefined
        ? ""
        : (detail.player?.publicId ?? ""),
    );
  };

  private async loadIdentity(): Promise<void> {
    const me = await getUserMe();
    this.applyPublicId(me === false ? "" : (me.player?.publicId ?? ""));
  }

  // Drop the cached history when the identity changes, so one player's games
  // never linger into another's view.
  private applyPublicId(publicId: string): void {
    if (publicId === this.publicId) return;
    this.publicId = publicId;
    this.historyCache = null;
  }

  public open(_args?: Record<string, unknown>): void {
    void this.loadIdentity();
  }

  // Mirrors BaseModal.close()'s inline-page branch (src/client/components/BaseModal.ts:237-241):
  // hand off to showPage, which hides this element (adds .hidden to the
  // current .page-content) and reveals page-play. Needed so Navigation.ts's
  // click-outside handler (Navigation.ts:130-149) — which calls close()
  // INSTEAD of showPage("page-play") whenever close is a function — actually
  // dismisses this page.
  public close(): void {
    window.showPage?.("page-play");
  }

  // Called by GameStatsModal's back button.
  public returnToGames(): void {
    window.showPage?.("page-history");
  }

  render(): TemplateResult {
    return html`
      <div class="px-3 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-7 space-y-4">
        <h1
          class="text-lg font-bold uppercase tracking-widest text-white text-center"
        >
          ${translateText("game_history.page_title")}
        </h1>
        ${this.publicId ? this.renderHistory() : this.renderSignedOut()}
      </div>
    `;
  }

  private renderSignedOut(): TemplateResult {
    return html`
      <div class="bg-white/5 border border-lt-700 p-12 text-center">
        <p class="text-lt-400 text-sm">
          ${translateText("game_history.not_signed_in")}
        </p>
      </div>
    `;
  }

  private renderHistory(): TemplateResult {
    return html`
      <game-history-metrics-header
        .games=${this.historyCache?.games ?? []}
      ></game-history-metrics-header>
      <player-game-history-view
        .publicId=${this.publicId}
        .cachedState=${this.historyCache?.publicId === this.publicId
          ? this.historyCache
          : null}
        @history-updated=${(e: CustomEvent<PlayerGameHistoryCache>) => {
          this.historyCache = e.detail;
        }}
        @view-stats=${(e: CustomEvent<{ gameId: string }>) =>
          this.openGameStats(e.detail.gameId)}
        @view-game=${(e: CustomEvent<{ gameId: string }>) =>
          this.viewGame(e.detail.gameId)}
      ></player-game-history-view>
    `;
  }

  private openGameStats(gameId: string): void {
    const statsModal = document.querySelector<
      HTMLElement & { openFromHistory(gameId: string): void }
    >("game-stats-modal");
    statsModal?.openFromHistory(gameId);
  }

  // Same navigation the account modal performs: push the game URL and let
  // Main's join-changed listener route into the replay.
  private viewGame(gameId: string): void {
    this.close();
    const encodedGameId = encodeURIComponent(gameId);
    const newUrl = `/${ClientEnv.workerPath(gameId)}/game/${encodedGameId}`;
    history.pushState({ join: gameId }, "", newUrl);
    window.dispatchEvent(
      new CustomEvent("join-changed", { detail: { gameId: encodedGameId } }),
    );
  }
}
