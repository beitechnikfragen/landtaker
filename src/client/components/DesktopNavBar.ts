import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import { NavNotificationsController } from "./NavNotificationsController";
import "./NavStatusCells";

@customElement("desktop-nav-bar")
export class DesktopNavBar extends LitElement {
  private _notifications = new NavNotificationsController(this);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("showPage", this._onShowPage);

    const current = window.currentPageId;
    if (current) {
      // Wait for render
      this.updateComplete.then(() => {
        this._updateActiveState(current);
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("showPage", this._onShowPage);
  }

  private _onShowPage = (e: Event) => {
    const pageId = (e as CustomEvent).detail;
    this._updateActiveState(pageId);
  };

  private _updateActiveState(pageId: string) {
    this.querySelectorAll(".nav-menu-item").forEach((el) => {
      if ((el as HTMLElement).dataset.page === pageId) {
        el.classList.add("active");
      } else {
        el.classList.remove("active");
      }
    });
  }

  /**
   * A tab that exists but isn't live yet: dimmed, unclickable, with a SOON
   * chip. Deliberately NOT a nav-menu-item — Main.ts binds navigation to that
   * class, and a disabled attribute alone would not stop that listener.
   */
  private renderComingSoon(labelKey: string) {
    return html`
      <!-- Chip text via data-i18n, NOT translateText: this bar renders once,
           before the language files load, and never re-renders — a render-time
           translation would freeze as the raw key. -->
      <div
        class="relative flex items-stretch"
        data-i18n-title="main.coming_soon"
      >
        <!-- Only the label dims — the SOON chip stays at full opacity so it
             actually reads. -->
        <button
          class="lt-nav-item cursor-not-allowed opacity-40"
          disabled
          data-i18n=${labelKey}
        ></button>
        <span
          class="absolute top-2 right-0 lt-num text-[10px] font-bold uppercase tracking-[0.08em] bg-lt-accent text-lt-accent-ink px-1.5 leading-[16px] pointer-events-none"
          data-i18n="main.soon"
        ></span>
      </div>
    `;
  }

  render() {
    window.currentPageId ??= "page-play";
    const currentPage = window.currentPageId;

    return html`
      <nav
        class="hidden lg:flex w-full h-[84px] bg-lt-900/90 backdrop-blur-md items-stretch shrink-0 z-50 relative border-b border-lt-700"
      >
        <!-- Brand sits at the left edge, separated by a rule rather than
             centred — the row then reads left-to-right like a title bar. -->
        <!-- Brand column, as in the mock: the mark plus the wordmark set in
             the display face. Type instead of the lockup's baked-in wordmark,
             because the SVG renders its lettering at a fraction of the mark's
             height — this stays razor-sharp at any size. -->
        <div
          class="flex items-center gap-3.5 pl-4 pr-7 mr-2 border-r border-lt-700"
        >
          <!-- The mark carries the brand, so it gets almost the full bar
               height; wordmark and version stack beside it. -->
          <img
            class="block h-[72px] w-[72px] shrink-0"
            src=${assetUrl("images/logo/mark.svg")}
            alt=""
            aria-hidden="true"
          />
          <div class="flex flex-col items-center gap-1">
            <span
              class="lt-display text-[26px] leading-none !tracking-[0.24em] text-lt-100"
              >LANDTAKER</span
            >
            <div
              id="game-version"
              class="lt-label !text-[10px] !tracking-[0.3em] text-center w-full"
            ></div>
          </div>
        </div>
        <button
          class="nav-menu-item lt-nav-item ${currentPage === "page-play"
            ? "active"
            : ""}"
          data-page="page-play"
          data-i18n="main.play"
        ></button>
        <!-- Desktop Navigation Menu Items -->
        <div class="relative flex items-stretch">
          <button
            class="nav-menu-item lt-nav-item ${currentPage === "page-news"
              ? "active"
              : ""}"
            data-page="page-news"
            data-i18n="main.news"
            @click=${this._notifications.onNewsClick}
          ></button>
          ${this._notifications.showNewsDot()
            ? html`
                <span
                  class="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full animate-ping"
                ></span>
                <span
                  class="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full"
                ></span>
              `
            : ""}
        </div>
        <!-- Store isn't stocked yet: the tab is visible so the plan reads,
             but disabled until there is something to sell. -->
        ${this.renderComingSoon("main.store")}
        <button
          class="nav-menu-item lt-nav-item"
          data-page="page-settings"
          data-i18n="main.settings"
        ></button>
        <button
          class="nav-menu-item lt-nav-item"
          data-page="page-leaderboard"
          data-i18n="main.leaderboard"
        ></button>
        <button
          class="nav-menu-item lt-nav-item"
          data-page="page-history"
          data-i18n="main.match_history"
        ></button>
        <!-- Clans exist upstream but aren't wired to our backend yet. -->
        ${this.renderComingSoon("main.clans")}
        <!-- Party moved into the social dock (friends-panel), so the nav
             stays about pages; page-party still exists for deep links. -->
        <div class="relative flex items-stretch">
          <button
            class="nav-menu-item lt-nav-item"
            data-page="page-help"
            data-i18n="main.help"
            @click=${this._notifications.onHelpClick}
          ></button>
          ${this._notifications.showHelpDot()
            ? html`
                <span
                  class="absolute -top-1 -right-1 w-2 h-2 bg-yellow-400 rounded-full animate-ping"
                ></span>
                <span
                  class="absolute -top-1 -right-1 w-2 h-2 bg-yellow-400 rounded-full"
                ></span>
              `
            : ""}
        </div>
        <!-- Push the status and account cells to the right edge; tabs stay left. -->
        <div class="flex-1"></div>
        <nav-status-cells class="flex items-stretch"></nav-status-cells>
        <button
          id="nav-account-button"
          class="nav-menu-item lt-nav-cell relative"
          data-page="page-account"
          data-i18n-aria-label="main.account"
          data-i18n-title="main.account"
        >
          <img
            id="nav-account-avatar"
            class="hidden w-7 h-7 object-cover border border-lt-600"
            alt=""
            data-i18n-alt="main.discord_avatar_alt"
            referrerpolicy="no-referrer"
          />
          <span
            id="nav-account-loading-spinner"
            class="w-4 h-4 border-2 border-lt-600 border-t-lt-100 rounded-full animate-spin"
            aria-hidden="true"
          ></span>
          <svg
            id="nav-account-person-icon"
            class="hidden w-[26px] h-[26px] text-lt-100"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20 21a8 8 0 0 0-16 0" />
            <path d="M12 13a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" />
          </svg>
          <span
            id="nav-account-email-badge"
            class="hidden absolute bottom-1 right-1 w-4 h-4 bg-lt-900/90 border border-lt-600 flex items-center justify-center"
            aria-hidden="true"
          >
            <svg
              class="w-2.5 h-2.5 text-lt-400"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 4h16v16H4z" opacity="0" />
              <path d="M4 6h16v12H4z" />
              <path d="m4 7 8 6 8-6" />
            </svg>
          </span>
          <span
            id="nav-account-signin-text"
            class="hidden lt-label !text-[13px] !text-lt-100"
            data-i18n="main.sign_in"
          >
          </span>
          <!--
            Signed in: the name beside the avatar, but only where it fits.
            The nav row is capped by the 1300px shell and does NOT grow with
            the viewport, so this is gated on the row's own free space (see
            .nav-username-slot) rather than a viewport media query — at any
            width, eight tabs plus the status cells leave no room for it.
          -->
          <span
            id="nav-account-username"
            class="hidden nav-username-slot lt-label !text-[13px] !text-lt-100 max-w-[120px] truncate"
          ></span>
        </button>
      </nav>
    `;
  }
}
