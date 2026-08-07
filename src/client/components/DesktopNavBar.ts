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

  render() {
    window.currentPageId ??= "page-play";
    const currentPage = window.currentPageId;

    return html`
      <nav
        class="hidden lg:flex w-full h-[76px] bg-lt-900/90 backdrop-blur-md items-stretch shrink-0 z-50 relative border-b border-lt-700"
      >
        <!-- Brand sits at the left edge, separated by a rule rather than
             centred — the row then reads left-to-right like a title bar. -->
        <!-- Brand column: the lockup at full readable size with the version
             centred beneath it, not squeezed beside it. -->
        <div
          class="flex flex-col items-center justify-center gap-1 pl-5 pr-7 mr-2 border-r border-lt-700"
        >
          <div class="h-12">
            <img
              class="block h-full aspect-[3943/1442]"
              src=${assetUrl("images/logo/lockup-horizontal.svg")}
              alt="Landtaker"
            />
          </div>
          <div
            id="game-version"
            class="lt-label !text-[10px] !tracking-[0.3em] text-center w-full"
          ></div>
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
        <div class="relative no-crazygames flex items-stretch">
          <button
            class="nav-menu-item lt-nav-item ${currentPage === "page-item-store"
              ? "active"
              : ""}"
            data-page="page-item-store"
            data-i18n="main.store"
            @click=${this._notifications.onStoreClick}
          ></button>
          ${this._notifications.showStoreDot()
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
          class="no-crazygames nav-menu-item lt-nav-item"
          data-page="page-clan"
          data-i18n="main.clans"
        ></button>
        <button
          class="no-crazygames nav-menu-item lt-nav-item"
          data-page="page-party"
          data-i18n="main.party"
        ></button>
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
            class="hidden w-5 h-5"
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
        </button>
      </nav>
    `;
  }
}
