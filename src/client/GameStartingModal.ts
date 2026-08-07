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
      <div
        class="fixed top-1/2 left-1/2 bg-lt-900/90 backdrop-blur-md border border-lt-700 p-6 z-[9999] shadow-2xl text-white w-[400px] text-center transition-all duration-300 -translate-x-1/2 ${isVisible
          ? "opacity-100 visible -translate-y-1/2"
          : "opacity-0 invisible -translate-y-[48%]"}"
      >
        <div
          class="text-base font-medium tracking-wider uppercase text-lt-500 mb-3"
        >
          © OpenFront and Contributors
        </div>
        <a
          href="https://github.com/openfrontio/OpenFrontIO/blob/main/CREDITS.md"
          target="_blank"
          rel="noopener noreferrer"
          class="block mb-4 text-lg font-medium tracking-wider uppercase text-lt-accent no-underline transition-colors duration-200 hover:text-lt-accent"
          >${translateText("game_starting_modal.credits")}</a
        >
        <p class="text-base text-lt-500 mb-4">
          ${translateText("game_starting_modal.code_license")}
        </p>
        <p
          class="text-xl font-medium tracking-wider text-white bg-white/5 border border-lt-700 px-4 py-3 "
        >
          ${translateText("game_starting_modal.title")}
        </p>
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
