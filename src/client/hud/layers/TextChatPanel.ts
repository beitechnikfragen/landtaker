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
  senderName: string;
  /** True when this client sent it, so it can be styled as one's own. */
  own: boolean;
}

/**
 * One tab. "all" and "team" always exist; a "player" thread appears the first
 * time a whisper is sent or received and is keyed by the counterpart's smallID.
 */
interface Conversation {
  id: string;
  channel: TextChatChannel;
  /** Counterpart smallID — only set for a whisper thread. */
  peerID?: number;
  /** Counterpart display name — only set for a whisper thread. */
  peerName?: string;
  lines: ChatLine[];
  unread: number;
  /** Kept per thread so switching tabs does not lose a half-typed message. */
  draft: string;
}

/** Lines kept per conversation. Older ones are dropped rather than rendered forever. */
const MAX_LINES_PER_CONVERSATION = 120;

const ALL_ID = "all";
const TEAM_ID = "team";

const whisperId = (peerID: number) => `player:${peerID}`;

/**
 * Free-text in-game chat, one tab per conversation.
 *
 * A single merged log becomes unreadable the moment two people talk at once,
 * so each whisper partner gets their own thread alongside All and Team. Threads
 * are derived from the delivery updates rather than tracked locally, which
 * means a reconnect rebuilds them from whatever the sim replays.
 *
 * Deliberately inert until focused: the panel sits over the map, so it must not
 * swallow clicks meant for the world. Only the panel chrome takes pointer
 * events, and the key handler ignores everything while the player is typing so
 * hotkeys (build menu, ratios) do not fire mid-message.
 */
@customElement("text-chat-panel")
export class TextChatPanel extends LitElement implements Controller {
  public eventBus: EventBus;
  public game: GameView;

  @state() private conversations: Conversation[] = [
    { id: ALL_ID, channel: "all", lines: [], unread: 0, draft: "" },
    { id: TEAM_ID, channel: "team", lines: [], unread: 0, draft: "" },
  ];
  @state() private activeId: string = ALL_ID;
  @state() private composing = false;
  @state() private collapsed = false;

  @query("#text-chat-input") private inputEl?: HTMLInputElement;
  @query("#text-chat-log") private logEl?: HTMLElement;

  private nextLineId = 0;
  private keyHandler = (e: KeyboardEvent) => this.onGlobalKey(e);
  /** Set when new lines arrived, so the log scrolls only when it should. */
  private pendingScroll = false;

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

  /** The channel the composer will send on. Read by tests. */
  get channel(): TextChatChannel {
    return this.active.channel;
  }

  private get active(): Conversation {
    return (
      this.conversations.find((c) => c.id === this.activeId) ??
      this.conversations[0]
    );
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

    let changed = false;
    for (const update of incoming) {
      // The execution addresses each update to one player. Anything else is
      // another player's mail and is dropped without rendering.
      if (update.recipientID !== myPlayer.smallID()) continue;
      this.appendLine(update, update.senderID === myPlayer.smallID());
      changed = true;
    }

    if (!changed) return;
    this.conversations = [...this.conversations];
    this.pendingScroll = true;
    this.requestUpdate();
  }

  private appendLine(update: DisplayTextChatUpdate, own: boolean) {
    const conversation = this.conversationFor(update);
    conversation.lines = [
      ...conversation.lines,
      {
        id: this.nextLineId++,
        text: update.text,
        senderName: update.senderName,
        own,
      },
    ].slice(-MAX_LINES_PER_CONVERSATION);

    // Own messages are never unread, and neither is the tab being watched.
    if (!own && (this.collapsed || conversation.id !== this.activeId)) {
      conversation.unread++;
    }
  }

  /** Finds the thread an update belongs to, opening a whisper tab on demand. */
  private conversationFor(update: DisplayTextChatUpdate): Conversation {
    if (update.channel !== "player") {
      const id = update.channel === "team" ? TEAM_ID : ALL_ID;
      return this.conversations.find((c) => c.id === id)!;
    }

    // whisperWithID is the counterpart from this client's point of view, so it
    // is correct for both the received and the sent copy.
    const peerID = update.whisperWithID;
    if (peerID === undefined) {
      return this.conversations.find((c) => c.id === ALL_ID)!;
    }

    const id = whisperId(peerID);
    const existing = this.conversations.find((c) => c.id === id);
    if (existing) {
      // Names can change; keep the tab label current.
      if (update.whisperWithName) existing.peerName = update.whisperWithName;
      return existing;
    }

    const created: Conversation = {
      id,
      channel: "player",
      peerID,
      peerName: update.whisperWithName ?? translateText("text_chat.unknown"),
      lines: [],
      unread: 0,
      draft: "",
    };
    this.conversations = [...this.conversations, created];
    return created;
  }

  /** Opens (or focuses) the whisper thread with a player. Called from PlayerPanel. */
  public startWhisper(target: PlayerView) {
    const peerID = target.smallID();
    const id = whisperId(peerID);
    if (!this.conversations.some((c) => c.id === id)) {
      this.conversations = [
        ...this.conversations,
        {
          id,
          channel: "player",
          peerID,
          peerName: target.displayName(),
          lines: [],
          unread: 0,
          draft: "",
        },
      ];
    }
    this.collapsed = false;
    this.selectTab(id);
    this.openComposer();
  }

  private selectTab(id: string) {
    // Carry the half-typed message with the tab it was typed in.
    if (this.composing) this.active.draft = this.inputEl?.value ?? "";
    this.activeId = id;
    const next = this.conversations.find((c) => c.id === id);
    if (next) next.unread = 0;
    this.conversations = [...this.conversations];
    this.pendingScroll = true;
    if (this.composing) {
      this.updateComplete.then(() => {
        if (this.inputEl) this.inputEl.value = this.active.draft;
        this.inputEl?.focus();
      });
    }
  }

  private closeTab(id: string, e: Event) {
    e.stopPropagation();
    // All and Team are permanent; only whisper threads can be dismissed.
    if (id === ALL_ID || id === TEAM_ID) return;
    this.conversations = this.conversations.filter((c) => c.id !== id);
    if (this.activeId === id) this.selectTab(ALL_ID);
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
    this.active.unread = 0;
    this.conversations = [...this.conversations];
    this.pendingScroll = true;
    this.updateComplete.then(() => {
      if (this.inputEl) this.inputEl.value = this.active.draft;
      this.inputEl?.focus();
    });
  }

  private closeComposer() {
    if (this.composing) this.active.draft = this.inputEl?.value ?? "";
    this.composing = false;
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
      // Tab walks the open tabs, so a whisper thread is reachable from the
      // keyboard without going back to the player panel.
      e.preventDefault();
      const i = this.conversations.findIndex((c) => c.id === this.activeId);
      const step = e.shiftKey ? -1 : 1;
      const next =
        this.conversations[
          (i + step + this.conversations.length) % this.conversations.length
        ];
      this.selectTab(next.id);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.send();
    }
  }

  private send() {
    const text = (this.inputEl?.value ?? "").trim();
    if (text.length === 0) {
      this.closeComposer();
      return;
    }
    if (text.length > TEXT_CHAT_MAX_LENGTH) return;

    const conversation = this.active;
    // A whisper thread whose player has left would be dropped by the sim, so
    // fall back to all-chat rather than losing the message.
    const peer =
      conversation.channel === "player" && conversation.peerID !== undefined
        ? this.game?.playerBySmallID(conversation.peerID)
        : undefined;
    const peerId = peer?.id() ?? undefined;
    const channel: TextChatChannel =
      conversation.channel === "player" && !peerId
        ? "all"
        : conversation.channel;

    this.eventBus.emit(
      new SendTextChatEvent(
        channel,
        text,
        channel === "player" ? peerId : undefined,
      ),
    );

    conversation.draft = "";
    // Clear the DOM value directly: Lit will not re-set `.value` when the
    // bound property returns to a value the element already reported, so the
    // sent text would otherwise stay visible in the box.
    if (this.inputEl) this.inputEl.value = "";
    this.conversations = [...this.conversations];
    // Keep the composer open so a reply can follow immediately.
    this.updateComplete.then(() => this.inputEl?.focus());
  }

  updated() {
    if (!this.pendingScroll) return;
    this.pendingScroll = false;
    // Newest line is at the bottom; without this a busy thread scrolls away.
    if (this.logEl) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private tabLabel(conversation: Conversation): string {
    switch (conversation.channel) {
      case "all":
        return translateText("text_chat.channel_all");
      case "team":
        return translateText("text_chat.channel_team");
      case "player":
        return conversation.peerName ?? translateText("text_chat.unknown");
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

  private get totalUnread(): number {
    return this.conversations.reduce((sum, c) => sum + c.unread, 0);
  }

  render() {
    if (!this.game?.myPlayer()) return html``;

    if (this.collapsed) {
      return html`
        <div class="flex flex-col items-start w-full sm:w-auto">
          <button
            class="pointer-events-auto flex items-center gap-2 px-2.5 py-1 text-[11px] tracking-[0.18em] uppercase text-lt-200 bg-[rgb(11_14_17/0.92)] border border-lt-700 hover:text-white"
            @click=${() => {
              this.collapsed = false;
              this.active.unread = 0;
              this.conversations = [...this.conversations];
              this.pendingScroll = true;
            }}
          >
            ${translateText("text_chat.title")}
            ${this.totalUnread > 0
              ? html`<span class="px-1.5 bg-lt-accent text-black font-semibold"
                  >${this.totalUnread}</span
                >`
              : ""}
          </button>
        </div>
      `;
    }

    const active = this.active;
    const remaining = TEXT_CHAT_MAX_LENGTH - (active.draft?.length ?? 0);

    return html`
      <div class="flex flex-col items-start w-full sm:w-[min(460px,42vw)]">
        <div
          class="w-full bg-[rgb(11_14_17/0.92)] border border-lt-700 backdrop-blur-md flex flex-col"
        >
          <!-- Tab strip. Scrolls sideways rather than wrapping, so a player
               with many open whispers never pushes the log off screen. -->
          <div class="flex items-stretch border-b border-lt-700/60">
            <div
              class="flex items-stretch min-w-0 flex-1 overflow-x-auto no-scrollbar"
            >
              ${this.conversations.map((c) => this.renderTab(c))}
            </div>
            <button
              class="pointer-events-auto shrink-0 px-2 text-[10px] tracking-[0.18em] uppercase text-lt-400 hover:text-white border-l border-lt-700/60"
              title=${translateText("text_chat.hide")}
              @click=${() => {
                this.closeComposer();
                this.collapsed = true;
              }}
            >
              ${translateText("text_chat.hide")}
            </button>
          </div>

          <div
            id="text-chat-log"
            class="flex flex-col gap-0.5 h-[26vh] overflow-y-auto px-2.5 py-1.5"
          >
            ${active.lines.length === 0
              ? html`<span class="text-[12px] text-lt-500 italic"
                  >${translateText("text_chat.empty")}</span
                >`
              : active.lines.map(
                  (line) => html`
                    <div class="text-[13px] leading-snug break-words">
                      <span
                        class="font-semibold ${line.own
                          ? "text-lt-accent"
                          : "text-lt-100"}"
                        >${line.senderName}</span
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
                      active.channel,
                    )} text-[10px] tracking-[0.14em] uppercase shrink-0"
                  >
                    ${this.tabLabel(active)}
                  </span>
                  <input
                    id="text-chat-input"
                    type="text"
                    autocomplete="off"
                    maxlength=${TEXT_CHAT_MAX_LENGTH}
                    .value=${active.draft}
                    placeholder=${translateText("text_chat.placeholder")}
                    class="flex-1 min-w-0 bg-transparent text-[13px] text-white outline-none placeholder:text-lt-500"
                    @input=${(e: Event) => {
                      active.draft = (e.target as HTMLInputElement).value;
                      this.requestUpdate();
                    }}
                    @keydown=${(e: KeyboardEvent) => this.onInputKey(e)}
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
      </div>
    `;
  }

  private renderTab(conversation: Conversation) {
    const isActive = conversation.id === this.activeId;
    const closable = conversation.channel === "player";

    return html`
      <button
        class="pointer-events-auto shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[11px] tracking-[0.12em] uppercase whitespace-nowrap border-r border-lt-700/60
          ${isActive
          ? `${this.channelClass(conversation.channel)} bg-lt-800 [box-shadow:inset_0_-2px_0_var(--color-lt-accent)]`
          : "text-lt-400 hover:text-lt-100"}"
        @click=${() => this.selectTab(conversation.id)}
      >
        <span>${this.tabLabel(conversation)}</span>
        ${conversation.unread > 0
          ? html`<span
              class="px-1 bg-lt-accent text-black text-[10px] font-semibold leading-tight"
              >${conversation.unread}</span
            >`
          : ""}
        ${closable
          ? html`<span
              role="button"
              tabindex="0"
              class="text-lt-500 hover:text-lt-bad leading-none"
              title=${translateText("text_chat.close_tab")}
              @click=${(e: Event) => this.closeTab(conversation.id, e)}
              >×</span
            >`
          : ""}
      </button>
    `;
  }
}
