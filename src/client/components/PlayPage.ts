import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import { crazyGamesSDK } from "../CrazyGamesSDK";
import "./HomeHero";
import "./NewsBox";
import "./StreamingNow";

@customElement("play-page")
export class PlayPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div
        id="page-play"
        class="flex flex-col gap-2 w-full px-0 lg:px-4 min-h-0"
      >
        <token-login class="absolute"></token-login>
        <rewards-modal class="absolute"></rewards-modal>

        <!-- Mobile: Fixed top bar -->
        <div
          class="lg:hidden fixed left-0 right-0 top-0 z-40 pt-[env(safe-area-inset-top)] bg-lt-900/95 backdrop-blur-md border-b border-lt-700"
        >
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center h-14 px-2 gap-2"
          >
            <button
              id="hamburger-btn"
              class="col-start-1 justify-self-start h-10 shrink-0 aspect-[4/3] flex text-lt-100 items-center justify-center transition-colors"
              data-i18n-aria-label="main.menu"
              aria-expanded="false"
              aria-controls="sidebar-menu"
              aria-haspopup="dialog"
              data-i18n-title="main.menu"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="size-8"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              </svg>
            </button>

            <div class="col-start-2 flex items-center justify-center min-w-0">
              <img
                src=${assetUrl("images/logo/lockup-horizontal.svg")}
                alt="Landtaker"
                class="h-full w-auto"
              />
            </div>

            ${crazyGamesSDK.isOnCrazyGames()
              ? html`
                  <button
                    id="crazygames-account-btn"
                    data-page="page-account"
                    class="nav-menu-item col-start-3 justify-self-end h-10 shrink-0 flex items-center justify-center overflow-hidden text-lt-100 cursor-pointer"
                    data-i18n-aria-label="main.account"
                    data-i18n-title="main.account"
                  >
                    <img
                      id="crazygames-account-avatar"
                      class="hidden w-8 h-8 object-cover border border-lt-600"
                      alt=""
                      referrerpolicy="no-referrer"
                    />
                    <svg
                      id="crazygames-account-icon"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                      class="w-7 h-7"
                    >
                      <path d="M20 21a8 8 0 0 0-16 0" />
                      <path d="M12 13a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" />
                    </svg>
                  </button>
                `
              : html`
                  <div
                    aria-hidden="true"
                    class="col-start-3 justify-self-end h-10 shrink-0 aspect-[4/3]"
                  ></div>
                `}
          </div>
        </div>

        <!-- Mobile: spacer for fixed top bar -->
        <div class="lg:hidden h-[calc(env(safe-area-inset-top)+56px)]"></div>

        <!-- Hero + commander rail. The rail holds the identity controls (flag,
             name, skin), so it exists on every breakpoint and for everyone —
             signed in just adds rank and history to it. On mobile only the
             rail renders; the display headline is desktop-only. -->
        <home-hero class="block w-full"></home-hero>

        <!-- Top strip: news on the left, Streaming Now on the right. The 2fr/1fr
             split only exists while the panel is live (.streaming-live via has-[]) —
             otherwise the left column takes the full row. -->
        <div
          class="w-full pb-4 lg:pb-0 flex flex-col gap-4 sm:-mx-4 sm:w-[calc(100%+2rem)] lg:mx-0 lg:w-full lg:grid lg:grid-cols-1 lg:has-[.streaming-live]:grid-cols-[2fr_1fr] lg:gap-4 lg:items-stretch"
        >
          <div class="flex flex-col gap-2 min-w-0">
            <news-box></news-box>
          </div>

          <!-- Right column: Streaming Now (desktop only), stretched to the left column's
               full height so the top strip has no dead space. -->
          <streaming-now
            class="hidden lg:flex lg:h-full lg:flex-col w-full min-w-0"
          ></streaming-now>
        </div>

        <game-mode-selector></game-mode-selector>

        <!-- Steam wishlist promo removed along with the footer one: it points
             at OpenFront's store page, not ours. -->
      </div>
    `;
  }
}
