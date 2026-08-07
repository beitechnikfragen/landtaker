import { html, LitElement, render as litRender } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { translateText } from "../Utils";

/**
 * A reusable inline confirmation / acknowledgement dialog.
 *
 * Usage:
 * ```html
 * <confirm-dialog
 *   .message=${"Are you sure?"}
 *   variant="danger"
 *   @confirm=${() => doThing()}
 *   @cancel=${() => {}}
 * ></confirm-dialog>
 * ```
 *
 * For ban-style flows, add a textarea:
 * ```html
 * <confirm-dialog
 *   .message=${"Ban this player?"}
 *   variant="warning"
 *   textareaPlaceholder="Reason (optional)"
 *   @confirm=${(e) => ban(e.detail.text)}
 *   @cancel=${() => {}}
 * ></confirm-dialog>
 * ```
 */
@customElement("confirm-dialog")
export class ConfirmDialog extends LitElement {
  @property() heading = "";
  @property() message = "";
  @property() variant: "danger" | "warning" = "danger";
  @property() textareaPlaceholder = "";
  @property() confirmText = "";
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) showClose = false;
  @property({ type: Boolean }) wide = false;
  @property() buttons: "confirmCancel" | "confirmOnly" | "none" =
    "confirmCancel";

  @state() private text = "";

  private portal: HTMLDivElement | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.portal = document.createElement("div");
    document.body.appendChild(this.portal);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.portal) {
      litRender(html``, this.portal);
      this.portal.remove();
      this.portal = null;
    }
  }

  render() {
    if (this.portal) {
      litRender(this.renderOverlay(), this.portal);
    }
    return html``;
  }

  private renderOverlay() {
    const isDanger = this.variant === "danger";
    const borderColor = isDanger ? "border-lt-bad/50" : "border-amber-500/50";
    const cardBg = "bg-surface";
    const textColor = isDanger ? "text-lt-bad" : "text-amber-300";
    const btnClass = isDanger
      ? "bg-lt-bad text-white hover:bg-lt-bad"
      : "bg-amber-600 text-white hover:bg-amber-700";

    return html`
      <div
        class="fixed inset-0 z-[10020] flex items-center justify-center bg-black/80"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this.handleCancel();
        }}
      >
        <div
          class="relative mx-4 w-full ${this.wide
            ? "max-w-md"
            : "max-w-sm"} p-6 border ${borderColor} ${cardBg} shadow-2xl"
        >
          ${this.showClose
            ? html`<button
                @click=${() => this.handleCancel()}
                class="absolute top-3 right-3 flex h-8 w-8 items-center justify-center text-xl leading-none text-lt-500 hover:bg-white/10 hover:text-white transition-all"
              >
                ×
              </button>`
            : ""}
          ${this.heading
            ? html`<h2 class="text-lg font-bold text-white mb-2 pr-8">
                ${this.heading}
              </h2>`
            : ""}
          <p class="text-sm font-medium ${textColor} mb-5">${this.message}</p>
          ${this.textareaPlaceholder
            ? html`<textarea
                .value=${this.text}
                @input=${(e: Event) =>
                  (this.text = (e.target as HTMLTextAreaElement).value)}
                maxlength="200"
                rows="2"
                placeholder="${this.textareaPlaceholder}"
                class="w-full px-3 py-2 mb-4 bg-white/5 border border-lt-700 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-amber-500/50 text-sm resize-none"
              ></textarea>`
            : ""}
          ${this.buttons === "none"
            ? ""
            : html`<div class="flex gap-3">
                ${this.buttons === "confirmCancel"
                  ? html`<button
                      @click=${() => this.handleCancel()}
                      ?disabled=${this.disabled}
                      class="flex-1 px-4 py-2.5 text-xs font-bold uppercase tracking-wider bg-white/5 text-lt-400 border border-lt-700 hover:bg-white/10 hover:text-lt-100 transition-all disabled:opacity-50 disabled:pointer-events-none"
                    >
                      ${translateText("common.cancel")}
                    </button>`
                  : ""}
                <button
                  @click=${() => this.handleConfirm()}
                  ?disabled=${this.disabled}
                  class="flex-1 px-4 py-2.5 text-xs font-bold uppercase tracking-wider ${btnClass} transition-all disabled:opacity-50 disabled:pointer-events-none border-0"
                >
                  ${this.confirmText || translateText("common.confirm")}
                </button>
              </div>`}
        </div>
      </div>
    `;
  }

  private handleConfirm() {
    this.dispatchEvent(
      new CustomEvent("confirm", { detail: { text: this.text } }),
    );
    this.text = "";
  }

  private handleCancel() {
    this.dispatchEvent(new CustomEvent("cancel"));
    this.text = "";
  }
}
