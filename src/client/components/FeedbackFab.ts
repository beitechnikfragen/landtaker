import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { FeedbackModal } from "../FeedbackModal";
import { modalRouter } from "../ModalRouter";
import { translateText } from "../Utils";

/**
 * The floating "send feedback" button.
 *
 * Feedback used to live only at the bottom of the help modal, behind a scroll
 * — findable if you already knew it existed, invisible otherwise. This is the
 * always-available entry point, in the menu AND during a match.
 *
 * Staying visible in-game is the deliberate part. Most overlays hide behind
 * `.in-game` because the board needs the room, but a bug is overwhelmingly
 * something you notice WHILE playing, and a button that disappears exactly
 * then is a button that collects reports about the main menu. It earns that
 * space by being quiet: half-transparent until you approach it.
 */
@customElement("feedback-fab")
export class FeedbackFab extends LitElement {
  /**
   * Suppressed while the feedback modal itself is open — the button would
   * otherwise float on top of the panel it just opened.
   *
   * NOT named `hidden`: HTMLElement already has a public `hidden` property,
   * and shadowing it with a private one is a type error.
   */
  @state() private suppressed = false;

  createRenderRoot() {
    return this;
  }

  private pollHandle: number | null = null;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("hashchange", this.syncVisibility);
    // hashchange alone misses the case that matters most: opening the modal
    // from code (our own button, or the help modal) does not always produce a
    // hash event before the modal is on screen. A slow poll is unglamorous
    // but reliable, and one boolean read per second costs nothing.
    this.pollHandle = window.setInterval(this.syncVisibility, 500);
    this.syncVisibility();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.syncVisibility);
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /**
   * Ask the modal itself rather than trusting the router: the router reflects
   * the URL, and the URL can lag a programmatic open by a frame or two.
   */
  private syncVisibility = () => {
    const modal = document.querySelector(
      "feedback-modal",
    ) as FeedbackModal | null;
    const open =
      (modal as unknown as { isModalOpen?: boolean })?.isModalOpen === true;
    this.suppressed = open || modalRouter.activeName() === "feedback";
  };

  /**
   * Capture where the user came from, THEN open the modal.
   *
   * Order matters and is the whole point of this handler: opening first would
   * make `modalRouter.activeName()` return "feedback", and every report would
   * claim it was written from the feedback screen.
   */
  private open = () => {
    const origin = modalRouter.activeName() ?? originFromBody();

    const modal = document.querySelector("feedback-modal") as FeedbackModal;
    if (!modal) {
      console.warn("Feedback modal element not found");
      return;
    }
    modal.open({ origin });
  };

  render() {
    if (this.suppressed) return nothing;

    // translateText() alone is not enough here: this component renders once at
    // startup, before the language file has loaded, so it would bake in the
    // raw key ("feedback_modal.title") and never revisit it. The data-i18n-*
    // attributes let LangSelector's translation pass rewrite them once the
    // strings arrive — the same mechanism the rest of the app relies on. The
    // translateText() call stays as the value for a later re-render, when the
    // strings ARE loaded and it resolves properly.
    const label = translateText("feedback_modal.title");

    return html`
      <button
        id="feedback-fab"
        aria-label=${label}
        title=${label}
        data-i18n-aria-label="feedback_modal.title"
        data-i18n-title="feedback_modal.title"
        @click=${this.open}
        class="fixed bottom-4 right-4 z-[30000] flex items-center justify-center
               w-11 h-11 rounded-full
               bg-lt-800/60 hover:bg-lt-800 border border-lt-600/60 hover:border-lt-accent
               text-lt-300 hover:text-lt-accent
               opacity-50 hover:opacity-100 focus-visible:opacity-100
               backdrop-blur-sm shadow-lg
               transition-all duration-200
               pointer-events-auto"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path
            d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
          ></path>
        </svg>
      </button>
    `;
  }
}

/**
 * Where the user is when no modal is routed: mid-match, or on the plain menu.
 *
 * `.in-game` on <body> is how the rest of the app already answers this
 * question (see Main.ts), so this reuses that single source of truth rather
 * than tracking match state a second time.
 */
function originFromBody(): string {
  return document.body.classList.contains("in-game") ? "in-game" : "menu";
}
