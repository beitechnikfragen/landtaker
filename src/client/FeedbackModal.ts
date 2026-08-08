import { html, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { userAuth } from "./Auth";
import { ClientEnv } from "./ClientEnv";
import { BaseModal } from "./components/BaseModal";
import { modalHeader } from "./components/ui/ModalHeader";
import {
  collectFeedbackContext,
  type FeedbackType,
  submitFeedback,
  type SubmitFeedbackResult,
} from "./FeedbackApi";
import { getTurnstileToken } from "./Turnstile";
import { translateText } from "./Utils";

/**
 * In-game feedback, bug reports and ideas.
 *
 * Guests may submit — a bug that prevents logging in has to be reportable —
 * so guests (and only guests) solve a Turnstile challenge before the request
 * goes out. Members are identified by their account instead.
 */

const MIN_MESSAGE_LENGTH = 10;
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Its own container element, separate from the join flow's. Turnstile renders
 * a real widget into whatever it is given; sharing one node would let the two
 * flows tear down each other's widget.
 */
const TURNSTILE_CONTAINER = "#feedback-turnstile-container";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

@customElement("feedback-modal")
export class FeedbackModal extends BaseModal {
  protected routerName = "feedback";

  @state() private type: FeedbackType = "bug";
  @state() private message = "";
  @state() private email = "";
  @state() private status: Status = { kind: "idle" };
  @state() private isLoggedIn = false;
  @state() private showTechnicalDetails = false;

  protected modalConfig() {
    return { maxWidth: "42rem" };
  }

  protected onOpen(): void {
    // Reset on every open: a stale success banner or a previous draft would
    // both be confusing.
    this.status = { kind: "idle" };
    this.message = "";
    this.email = "";
    this.type = "bug";
    void this.refreshLoginState();
  }

  private async refreshLoginState(): Promise<void> {
    this.isLoggedIn = (await userAuth()) !== false;
  }

  private get trimmedMessage(): string {
    return this.message.trim();
  }

  private get canSubmit(): boolean {
    return (
      this.status.kind !== "submitting" &&
      this.trimmedMessage.length >= MIN_MESSAGE_LENGTH &&
      this.trimmedMessage.length <= MAX_MESSAGE_LENGTH
    );
  }

  private async onSubmit(): Promise<void> {
    if (!this.canSubmit) return;
    this.status = { kind: "submitting" };

    // Guests only. A member already has a bannable account, so a challenge
    // costs them a failure mode and buys us nothing.
    let turnstileToken: string | null = null;
    if (!this.isLoggedIn) {
      // Desktop (Steam) never loads the Turnstile script — Main.ts skips the
      // prefetch there for the same reason — so getTurnstileToken() would
      // poll for ~10s before throwing. A signed-out desktop user can't pass
      // the guest challenge at all; they must log in to submit, so fail fast
      // instead of making them watch a stuck "Sending..." button.
      if (
        typeof window.turnstile === "undefined" &&
        ClientEnv.instanceId() === "desktop"
      ) {
        this.status = {
          kind: "error",
          message: translateText("feedback_modal.error_captcha"),
        };
        return;
      }
      try {
        turnstileToken = (await getTurnstileToken(TURNSTILE_CONTAINER)).token;
      } catch {
        this.status = {
          kind: "error",
          message: translateText("feedback_modal.error_captcha"),
        };
        return;
      }
    }

    const result = await submitFeedback({
      type: this.type,
      message: this.trimmedMessage,
      contactEmail: this.email.trim().length > 0 ? this.email.trim() : null,
      context: collectFeedbackContext(this.routerName ?? "feedback"),
      turnstileToken,
    });

    if (result.ok) {
      this.status = { kind: "success" };
      this.message = "";
      this.email = "";
      return;
    }

    this.status = { kind: "error", message: this.errorMessage(result) };
  }

  private errorMessage(
    result: Extract<SubmitFeedbackResult, { ok: false }>,
  ): string {
    switch (result.kind) {
      case "rate_limited": {
        // Round UP and floor at 1: telling someone to retry in "0 minutes"
        // would be nonsense, and rounding down would send them back early to
        // another refusal. The en.json string uses ICU plural syntax, so
        // "1 minute" vs "5 minutes" is handled by the formatter rather than
        // by branching here — which also keeps it correct in languages whose
        // plural rules are not English's.
        const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
        return translateText("feedback_modal.error_rate_limited", {
          minutes,
        });
      }
      case "captcha_failed":
        return translateText("feedback_modal.error_captcha");
      case "network":
        return translateText("feedback_modal.error_network");
      case "invalid":
        return translateText("feedback_modal.error_invalid");
      case "server":
        return translateText("feedback_modal.error_server");
    }
  }

  private renderTypeButton(type: FeedbackType, labelKey: string) {
    const selected = this.type === type;
    return html`
      <button
        type="button"
        class="px-4 py-2 border transition-colors ${selected
          ? "bg-lt-accent border-lt-accent text-lt-900"
          : "bg-lt-800 border-lt-600 text-lt-100 hover:border-lt-accent"}"
        aria-pressed=${selected}
        @click=${() => {
          this.type = type;
        }}
      >
        ${translateText(labelKey)}
      </button>
    `;
  }

  private renderTechnicalDetails(): TemplateResult {
    const context = collectFeedbackContext(this.routerName ?? "feedback");
    return html`
      <div class="mt-4">
        <button
          type="button"
          class="text-sm text-lt-300 underline"
          @click=${() => {
            this.showTechnicalDetails = !this.showTechnicalDetails;
          }}
        >
          ${translateText("feedback_modal.technical_details")}
        </button>
        ${this.showTechnicalDetails
          ? html`
              <pre
                class="mt-2 p-3 bg-lt-900 border border-lt-700 text-xs text-lt-300 overflow-x-auto whitespace-pre-wrap"
              >
${JSON.stringify(context, null, 2)}</pre
              >
            `
          : null}
      </div>
    `;
  }

  protected renderHeaderSlot(): TemplateResult {
    return modalHeader({
      title: translateText("feedback_modal.title"),
      onBack: () => this.close(),
    });
  }

  protected renderBody(): TemplateResult {
    const length = this.trimmedMessage.length;

    return html`
      <div class="p-4 lg:p-6">
        <p class="text-lt-300 mb-4">${translateText("feedback_modal.intro")}</p>

        <div class="flex gap-2 mb-4">
          ${this.renderTypeButton("bug", "feedback_modal.type_bug")}
          ${this.renderTypeButton("idea", "feedback_modal.type_idea")}
          ${this.renderTypeButton("other", "feedback_modal.type_other")}
        </div>

        <label class="block text-lt-100 mb-1" for="feedback-message">
          ${translateText("feedback_modal.message_label")}
        </label>
        <textarea
          id="feedback-message"
          rows="6"
          maxlength=${MAX_MESSAGE_LENGTH}
          class="w-full p-3 bg-lt-900 border border-lt-600 text-lt-100 focus:border-lt-accent outline-none"
          placeholder=${translateText("feedback_modal.message_placeholder")}
          .value=${this.message}
          @input=${(e: Event) => {
            this.message = (e.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
        <div class="text-xs text-lt-400 text-right">
          ${length} / ${MAX_MESSAGE_LENGTH}
        </div>

        ${this.isLoggedIn
          ? null
          : html`
              <label class="block text-lt-100 mt-4 mb-1" for="feedback-email">
                ${translateText("feedback_modal.email_label")}
              </label>
              <input
                id="feedback-email"
                type="email"
                class="w-full p-3 bg-lt-900 border border-lt-600 text-lt-100 focus:border-lt-accent outline-none"
                placeholder=${translateText("feedback_modal.email_placeholder")}
                .value=${this.email}
                @input=${(e: Event) => {
                  this.email = (e.target as HTMLInputElement).value;
                }}
              />
              <div class="text-xs text-lt-400 mt-1">
                ${translateText("feedback_modal.email_hint")}
              </div>
            `}
        ${this.renderTechnicalDetails()}
        ${this.status.kind === "success"
          ? html`<div class="mt-4 p-3 border border-green-600 text-green-400">
              ${translateText("feedback_modal.success")}
            </div>`
          : null}
        ${this.status.kind === "error"
          ? html`<div class="mt-4 p-3 border border-red-600 text-red-400">
              ${this.status.message}
            </div>`
          : null}

        <button
          type="button"
          class="mt-4 w-full py-3 bg-lt-accent text-lt-900 disabled:opacity-50 disabled:cursor-not-allowed"
          ?disabled=${!this.canSubmit}
          @click=${() => void this.onSubmit()}
        >
          ${this.status.kind === "submitting"
            ? translateText("feedback_modal.submitting")
            : translateText("feedback_modal.submit")}
        </button>
      </div>
    `;
  }
}
