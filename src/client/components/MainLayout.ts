import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("main-layout")
export class MainLayout extends LitElement {
  private _initialChildren: Node[] = [];

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    if (this._initialChildren.length === 0 && this.childNodes.length > 0) {
      this._initialChildren = Array.from(this.childNodes);
    }
    super.connectedCallback();
  }

  render() {
    return html`
      <main
        class="relative [.in-game_&]:hidden flex flex-col flex-1 overflow-hidden w-full px-0 lg:px-[clamp(1.5rem,3vw,3rem)] pt-0 lg:pt-[clamp(0.75rem,1.5vw,1.5rem)] pb-0 lg:pb-[clamp(0.375rem,0.75vw,0.75rem)]"
      >
        <!-- The old 20cm cap (~756px) left a game menu sitting in a narrow
             column with the map wasted either side. 1400px gives the hero room
             for its rail and lets the lobby cards read as real map previews,
             while still stopping the row from stretching on ultrawide. -->
        <div
          class="w-full lg:max-w-[1400px] mx-auto flex flex-col flex-1 gap-0 lg:gap-4 overflow-y-auto overflow-x-hidden sm:px-4 lg:px-0"
        >
          ${this._initialChildren}
        </div>
      </main>
    `;
  }
}
