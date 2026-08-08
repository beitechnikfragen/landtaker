import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "./Utils";

@customElement("game-starting-modal")
export class GameStartingModal extends LitElement {
  @state()
  isVisible = false;

  createRenderRoot() {
    return this;
  }

  render() {
    const isVisible = this.isVisible;
    return html`
      <div
        class="fixed inset-0 bg-black/30 backdrop-blur-[4px] z-[9998] transition-all duration-300 ${isVisible
          ? "opacity-100 visible"
          : "opacity-0 invisible"}"
      ></div>
      <!-- Just the state, no license splash: attribution and the AGPL notice
           live in the footer and the repo, where they belong. -->
      <div
        class="fixed top-1/2 left-1/2 bg-lt-900/90 backdrop-blur-md border border-lt-700 p-6 z-[9999] shadow-2xl text-white w-[360px] text-center transition-all duration-300 -translate-x-1/2 ${isVisible
          ? "opacity-100 visible -translate-y-1/2"
          : "opacity-0 invisible -translate-y-[48%]"}"
      >
        <p
          class="lt-display text-[22px] uppercase tracking-[0.1em] text-white leading-none"
        >
          ${translateText("game_starting_modal.title")}
        </p>
        <div class="lt-meter mt-4">
          <i class="animate-pulse" style="width: 100%"></i>
        </div>
      </div>
    `;
  }

  show() {
    this.isVisible = true;
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    this.requestUpdate();
  }
}
