import { html, LitElement } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import {
  DisplayTextChatUpdate,
  GameUpdateType,
} from "../../../core/game/GameUpdates";
import { TEXT_CHAT_MAX_LENGTH, TextChatChannel } from "../../../core/Schemas";
import { Controller } from "../../Controller";
import { SendTextChatEvent } from "../../Transport";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

interface ChatLine {
  id: number;
  text: string;
  channel: TextChatChannel;
  senderName: string;
  /** True when this client sent it, so it can be styled as one's own. */
  own: boolean;
  /** Whisper direction, so "to X" and "from X" read correctly. */
  whisperTo: string | null;
}

/** Lines kept in the log. Older ones are dropped rather than rendered forever. */
const MAX_LINES = 120;

/** Channels the player can cycle through with Tab. */
const CYCLE: TextChatChannel[] = ["all", "team"];

/**
 * Free-text in-game chat.
 *
 * Deliberately inert until focused: the panel sits over the map, so it must not
 * swallow clicks meant for the world. Only the input row takes pointer events,
 * and the key handler ignores everything while the player is typing so that
 * hotkeys (build menu, ratios) do not fire mid-message.
 */
@customElement("text-chat-panel")
export class TextChatPanel extends LitElement implements Controller {
  public eventBus: EventBus;
  public game: GameView;

  @state() private lines: ChatLine[] = [];
  @state() private composing = false;
  // Not private: the whisper entry point and tests read it.
  @state() channel: TextChatChannel = "all";
  @state() private draft = "";
  /** Set when the player picked a specific target from the player panel. */
  @state() private whisperTarget: PlayerView | null = null;
  @state() private unread = 0;
  @state() private collapsed = false;

  @query("#text-chat-input") private inputEl?: HTMLInputElement;

  private nextLineId = 0;
  private keyHandler = (e: KeyboardEvent) => this.onGlobalKey(e);

  createRenderRoot() {
    return this;
  }

  init() {
    window.addEventListener("keydown", this.keyHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.keyHandler);
  }

  tick() {
    const updates = this.game?.updatesSinceLastTick();
    if (!updates) return;

    const incoming = updates[GameUpdateType.DisplayTextChatEvent] as
      | DisplayTextChatUpdate[]
      | undefined;
    if (!incoming?.length) return;

    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    let appended = false;
    for (const update of incoming) {
      // The execution addresses each update to one player. Anything else is
      // another player's mail and is dropped without rendering.
      if (update.recipientID !== myPlayer.smallID()) continue;

      const own = update.senderID === myPlayer.smallID();
      this.lines = [
        ...this.lines,
        {
          id: this.nextLineId++,
          text: update.text,
          channel: update.channel,
          senderName: update.senderName,
          own,
          whisperTo:
            update.channel === "player" && own
              ? (this.whisperTarget?.displayName() ?? null)
              : null,
        },
      ];
      appended = true;
      if (!own && this.collapsed) this.unread++;
    }

    if (!appended) return;
    if (this.lines.length > MAX_LINES) {
      this.lines = this.lines.slice(-MAX_LINES);
    }
    this.requestUpdate();
  }

  /** Opens the composer aimed at a specific player. Called from PlayerPanel. */
  public startWhisper(target: PlayerView) {
    this.whisperTarget = target;
    this.channel = "player";
    this.collapsed = false;
    this.openComposer();
  }

  private onGlobalKey(e: KeyboardEvent) {
    if (this.composing) return;
    // Never steal keys from another input (lobby name, search fields).
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    ) {
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    this.collapsed = false;
    this.openComposer();
  }

  private openComposer() {
    this.composing = true;
    this.unread = 0;
    this.updateComplete.then(() => this.inputEl?.focus());
  }

  private closeComposer() {
    this.composing = false;
    this.draft = "";
    this.inputEl?.blur();
  }

  private onInputKey(e: KeyboardEvent) {
    // Stop game hotkeys from firing while typing.
    e.stopPropagation();

    if (e.key === "Escape") {
      e.preventDefault();
      this.closeComposer();
      return;
    }
    if (e.key === "Tab") {
      // Tab cycles all/team. Whisper is not in the cycle — it needs a target,
      // which is chosen from the player panel.
      e.preventDefault();
      if (this.channel === "player") {
        this.channel = "all";
        this.whisperTarget = null;
      } else {
        const i = CYCLE.indexOf(this.channel);
        this.channel = CYCLE[(i + 1) % CYCLE.length];
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.send();
    }
  }

  private send() {
    const text = this.draft.trim();
    if (text.length === 0) {
      this.closeComposer();
      return;
    }
    if (text.length > TEXT_CHAT_MAX_LENGTH) return;

    // A whisper with no live target would be silently dropped by the sim, so
    // fall back to all-chat rather than losing the message.
    const channel: TextChatChannel =
      this.channel === "player" && !this.whisperTarget ? "all" : this.channel;

    this.eventBus.emit(
      new SendTextChatEvent(
        channel,
        text,
        channel === "player" ? this.whisperTarget?.id() : undefined,
      ),
    );

    this.draft = "";
    // Clear the DOM value directly: Lit will not re-set `.value` when the
    // bound property returns to a value the element already reported, so the
    // sent text would otherwise stay visible in the box.
    if (this.inputEl) this.inputEl.value = "";
    // Keep the composer open so a reply can follow immediately.
    this.updateComplete.then(() => this.inputEl?.focus());
  }

  private channelLabel(channel: TextChatChannel): string {
    switch (channel) {
      case "all":
        return translateText("text_chat.channel_all");
      case "team":
        return translateText("text_chat.channel_team");
      case "player":
        return translateText("text_chat.channel_whisper");
    }
  }

  /** Channel accent. Whisper and team must be distinguishable at a glance so
   * nobody types a private message into all-chat by accident. */
  private channelClass(channel: TextChatChannel): string {
    switch (channel) {
      case "all":
        return "text-lt-200";
      case "team":
        return "text-lt-troop";
      case "player":
        return "text-lt-accent";
    }
  }

  render() {
    if (!this.game?.myPlayer()) return html``;

    const remaining = TEXT_CHAT_MAX_LENGTH - this.draft.length;

    return html`
      <div class="flex flex-col items-start w-full sm:w-[min(420px,40vw)]">
        ${this.collapsed
          ? html`
              <button
                class="pointer-events-auto flex items-center gap-2 px-2.5 py-1 text-[11px] tracking-[0.18em] uppercase text-lt-200 bg-[rgb(11_14_17/0.92)] border border-lt-700 hover:text-white"
                @click=${() => {
                  this.collapsed = false;
                  this.unread = 0;
                }}
              >
                ${translateText("text_chat.title")}
                ${this.unread > 0
                  ? html`<span
                      class="px-1.5 bg-lt-accent text-black font-semibold"
                      >${this.unread}</span
                    >`
                  : ""}
              </button>
            `
          : html`
              <div
                class="w-full bg-[rgb(11_14_17/0.92)] border border-lt-700 backdrop-blur-md flex flex-col"
              >
                <div
                  class="flex items-center justify-between px-2.5 py-1 border-b border-lt-700/60"
                >
                  <span
                    class="text-[10px] tracking-[0.22em] uppercase text-lt-400"
                    >${translateText("text_chat.title")}</span
                  >
                  <button
                    class="pointer-events-auto text-[10px] tracking-[0.18em] uppercase text-lt-400 hover:text-white"
                    @click=${() => (this.collapsed = true)}
                  >
                    ${translateText("text_chat.hide")}
                  </button>
                </div>

                <div
                  class="flex flex-col gap-0.5 max-h-[26vh] overflow-y-auto px-2.5 py-1.5"
                >
                  ${this.lines.length === 0
                    ? html`<span class="text-[12px] text-lt-500 italic"
                        >${translateText("text_chat.empty")}</span
                      >`
                    : this.lines.map(
                        (line) => html`
                          <div class="text-[13px] leading-snug break-words">
                            <span
                              class="${this.channelClass(
                                line.channel,
                              )} text-[10px] tracking-[0.14em] uppercase mr-1"
                              >${this.channelLabel(line.channel)}</span
                            >
                            <span
                              class="font-semibold ${line.own
                                ? "text-lt-accent"
                                : "text-lt-100"}"
                              >${line.whisperTo
                                ? `${translateText("text_chat.to")} ${line.whisperTo}`
                                : line.senderName}</span
                            >
                            <span class="text-lt-400">:</span>
                            <span class="text-lt-100">${line.text}</span>
                          </div>
                        `,
                      )}
                </div>

                ${this.composing
                  ? html`
                      <div
                        class="pointer-events-auto flex items-center gap-2 px-2.5 py-1.5 border-t border-lt-700/60"
                      >
                        <span
                          class="${this.channelClass(
                            this.channel,
                          )} text-[10px] tracking-[0.14em] uppercase shrink-0"
                        >
                          ${this.channel === "player" && this.whisperTarget
                            ? `${this.channelLabel(this.channel)} ${this.whisperTarget.displayName()}`
                            : this.channelLabel(this.channel)}
                        </span>
                        <input
                          id="text-chat-input"
                          type="text"
                          autocomplete="off"
                          maxlength=${TEXT_CHAT_MAX_LENGTH}
                          .value=${this.draft}
                          placeholder=${translateText("text_chat.placeholder")}
                          class="flex-1 min-w-0 bg-transparent text-[13px] text-white outline-none placeholder:text-lt-500"
                          @input=${(e: Event) => {
                            this.draft = (e.target as HTMLInputElement).value;
                          }}
                          @keydown=${(e: KeyboardEvent) => this.onInputKey(e)}
                          @blur=${() => {
                            if (this.draft.trim().length === 0) {
                              this.composing = false;
                            }
                          }}
                        />
                        <span
                          class="text-[10px] shrink-0 ${remaining < 20
                            ? "text-lt-bad"
                            : "text-lt-500"}"
                          >${remaining}</span
                        >
                      </div>
                    `
                  : html`
                      <button
                        class="pointer-events-auto text-left px-2.5 py-1.5 border-t border-lt-700/60 text-[12px] text-lt-500 hover:text-lt-200"
                        @click=${() => this.openComposer()}
                      >
                        ${translateText("text_chat.prompt")}
                      </button>
                    `}
              </div>
            `}
      </div>
    `;
  }
}
