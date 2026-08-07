import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  FriendEntry,
  FriendMessage,
  FriendStreamEvent,
  UserMeResponse,
} from "../../core/ApiSchemas";
import { hasLinkedAccount } from "../Api";
import {
  acceptFriendRequest,
  connectFriendsStream,
  deleteFriendRequest,
  fetchFriendRequests,
  fetchFriends,
  fetchMessages,
  sendChatMessage,
  sendFriendRequest,
  type FriendsStreamHandle,
} from "../FriendsApi";
import { translateText } from "../Utils";

/**
 * The always-there social dock: a collapsible panel pinned to the bottom-right
 * of every main-menu page (hidden in game, where the HUD owns the screen).
 *
 * Presence and incoming messages arrive over one SSE stream
 * (connectFriendsStream); everything the user does goes through the same REST
 * calls the account modal's friends tab uses. The stream also echoes the
 * user's own sends, so messages are deduplicated by id rather than appended
 * blindly.
 */
@customElement("friends-panel")
export class FriendsPanel extends LitElement {
  @state() private userMeResponse: UserMeResponse | false = false;
  @state() private open = localStorage.getItem("friendsPanelOpen") === "1";
  @state() private friends: FriendEntry[] = [];
  @state() private incoming: FriendEntry[] = [];
  @state() private unread: Map<string, number> = new Map();
  /** publicId of the open conversation, or null for the list view. */
  @state() private activeChat: string | null = null;
  @state() private messages: FriendMessage[] = [];
  @state() private addValue = "";
  @state() private addNote: string | null = null;

  private stream: FriendsStreamHandle | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this.onUserMe as EventListener);
  }

  disconnectedCallback() {
    document.removeEventListener(
      "userMeResponse",
      this.onUserMe as EventListener,
    );
    this.teardown();
    super.disconnectedCallback();
  }

  private onUserMe = (e: CustomEvent<UserMeResponse | false>) => {
    const wasLinked = this.linked();
    this.userMeResponse = e.detail;
    const isLinked = this.linked();
    if (isLinked && !wasLinked) void this.start();
    if (!isLinked && wasLinked) this.teardown();
  };

  private linked(): boolean {
    return (
      this.userMeResponse !== false && hasLinkedAccount(this.userMeResponse)
    );
  }

  private myPublicId(): string {
    return this.userMeResponse !== false
      ? (this.userMeResponse.player?.publicId ?? "")
      : "";
  }

  private async start() {
    await this.refresh();
    this.stream ??= connectFriendsStream((event) => this.onStreamEvent(event));
  }

  private teardown() {
    this.stream?.close();
    this.stream = null;
    this.friends = [];
    this.incoming = [];
    this.unread = new Map();
    this.activeChat = null;
    this.messages = [];
  }

  private async refresh() {
    const [friends, requests] = await Promise.all([
      fetchFriends(1, 100),
      fetchFriendRequests(),
    ]);
    if (friends !== false) this.friends = friends.results;
    if (requests !== false) this.incoming = requests.incoming;
  }

  private onStreamEvent(event: FriendStreamEvent) {
    if (event.type === "presence") {
      this.friends = this.friends.map((friend) =>
        friend.publicId === event.publicId
          ? { ...friend, online: event.online }
          : friend,
      );
      return;
    }

    // A chat message. Identify the other party: for our own echoed sends
    // that's the recipient, otherwise the sender.
    const mine = event.message.from === this.myPublicId();
    const other = mine ? event.message.to : event.message.from;

    if (this.activeChat === other) {
      if (!this.messages.some((m) => m.id === event.message.id)) {
        this.messages = [...this.messages, event.message];
        this.scrollChatDown();
      }
      return;
    }
    if (!mine) {
      const next = new Map(this.unread);
      next.set(other, (next.get(other) ?? 0) + 1);
      this.unread = next;
      // A message from someone not yet in the list (brand-new friend) —
      // refresh so the row exists to hang the badge on.
      if (!this.friends.some((f) => f.publicId === other)) void this.refresh();
    }
  }

  private toggleOpen() {
    this.open = !this.open;
    localStorage.setItem("friendsPanelOpen", this.open ? "1" : "0");
  }

  private async openChat(publicId: string) {
    this.activeChat = publicId;
    this.messages = [];
    const next = new Map(this.unread);
    next.delete(publicId);
    this.unread = next;
    const history = await fetchMessages(publicId);
    if (history !== false && this.activeChat === publicId) {
      this.messages = history.results;
      this.scrollChatDown();
    }
  }

  private scrollChatDown() {
    requestAnimationFrame(() => {
      const el = this.querySelector(".friends-chat-scroll");
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  private async handleSendMessage(e: Event) {
    e.preventDefault();
    if (this.activeChat === null) return;
    const input = this.querySelector(
      ".friends-chat-input",
    ) as HTMLInputElement | null;
    const body = input?.value.trim() ?? "";
    if (body.length === 0) return;
    if (input) input.value = "";
    const sent = await sendChatMessage(this.activeChat, body);
    if (sent !== false && !this.messages.some((m) => m.id === sent.id)) {
      this.messages = [...this.messages, sent];
      this.scrollChatDown();
    }
  }

  private async handleAdd(e: Event) {
    e.preventDefault();
    const value = this.addValue.trim();
    if (value.length === 0) return;
    const result = await sendFriendRequest(value);
    if (typeof result === "string") {
      this.addNote = translateText(
        result === "not_found"
          ? "friends.error_not_found"
          : result === "conflict"
            ? "friends.error_conflict"
            : result === "bad_request"
              ? "friends.error_bad_request"
              : "friends.error_generic",
      );
    } else {
      this.addNote = translateText(
        result.status === "accepted"
          ? "friends.request_auto_accepted"
          : "friends.request_sent",
      );
      this.addValue = "";
      void this.refresh();
    }
  }

  private async handleRequest(publicId: string, accept: boolean) {
    if (accept) await acceptFriendRequest(publicId);
    else await deleteFriendRequest(publicId);
    void this.refresh();
  }

  private nameOf(entry: FriendEntry): string {
    return entry.username ?? entry.publicId;
  }

  private unreadTotal(): number {
    let sum = 0;
    for (const n of this.unread.values()) sum += n;
    return sum;
  }

  render() {
    if (!this.linked()) return nothing;

    const onlineCount = this.friends.filter((f) => f.online === true).length;
    const unreadTotal = this.unreadTotal();

    return html`
      <div
        class="hidden lg:block in-[.in-game]:hidden fixed bottom-0 right-4 z-[900] w-[300px] pointer-events-auto"
      >
        <!-- Collapsed bar / panel header -->
        <button
          class="w-full flex items-center gap-2 px-3 h-[38px] bg-[rgb(11_14_17/0.96)] border border-lt-700 ${this
            .open
            ? "border-b-0"
            : ""} cursor-pointer"
          @click=${() => this.toggleOpen()}
        >
          <span class="lt-label !text-[11px] !text-lt-100"
            >${translateText("friends.title")}</span
          >
          <span class="lt-label !text-[10px]"
            >${onlineCount}/${this.friends.length}
            ${translateText("friends.online")}</span
          >
          ${unreadTotal > 0
            ? html`<span
                class="lt-num min-w-[18px] h-[16px] px-1 grid place-items-center bg-lt-accent text-lt-accent-ink text-[11px] font-bold"
                >${unreadTotal}</span
              >`
            : nothing}
          ${this.incoming.length > 0
            ? html`<span
                class="lt-num min-w-[18px] h-[16px] px-1 grid place-items-center border border-lt-accent/60 text-lt-accent text-[11px] font-bold"
                >${this.incoming.length}</span
              >`
            : nothing}
          <span class="ml-auto text-lt-400" aria-hidden="true"
            >${this.open ? "▾" : "▴"}</span
          >
        </button>

        ${this.open
          ? html`<div
              class="bg-[rgb(11_14_17/0.96)] border border-lt-700 border-t-lt-700 flex flex-col h-[400px]"
            >
              ${this.activeChat !== null
                ? this.renderChat()
                : this.renderList()}
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderList() {
    return html`
      <!-- Add friend -->
      <form
        class="flex gap-1 p-2 border-b border-lt-700"
        @submit=${(e: Event) => void this.handleAdd(e)}
      >
        <input
          class="flex-1 min-w-0 bg-lt-800 border border-lt-600 px-2 py-1 text-[13px] text-lt-100 placeholder:text-lt-500 outline-none focus:border-lt-accent"
          .value=${this.addValue}
          @input=${(e: Event) => {
            this.addValue = (e.target as HTMLInputElement).value;
            this.addNote = null;
          }}
          placeholder=${translateText("friends.public_id_placeholder")}
        />
        <button class="lt-btn !py-1 !px-2.5 text-[12px]" type="submit">
          ${translateText("friends.add_friend")}
        </button>
      </form>
      ${this.addNote !== null
        ? html`<div class="px-2.5 py-1 lt-label !text-[10px] !text-lt-400">
            ${this.addNote}
          </div>`
        : nothing}

      <div class="flex-1 overflow-y-auto">
        <!-- Incoming requests first: they need an answer. -->
        ${this.incoming.length > 0
          ? html`
              <div class="lt-rail-h">${translateText("friends.incoming")}</div>
              ${this.incoming.map(
                (request) => html`
                  <div
                    class="flex items-center gap-2 px-2.5 py-1.5 border-b border-lt-700/45"
                  >
                    <span
                      class="flex-1 min-w-0 truncate text-[13px] text-lt-100"
                      >${this.nameOf(request)}</span
                    >
                    <button
                      class="lt-label !text-[10px] border border-lt-600 px-1.5 py-px hover:!text-lt-ok hover:border-lt-ok/50"
                      @click=${() =>
                        void this.handleRequest(request.publicId, true)}
                    >
                      ${translateText("friends.accept")}
                    </button>
                    <button
                      class="lt-label !text-[10px] border border-lt-600 px-1.5 py-px hover:!text-lt-bad hover:border-lt-bad/50"
                      @click=${() =>
                        void this.handleRequest(request.publicId, false)}
                    >
                      ${translateText("friends.deny")}
                    </button>
                  </div>
                `,
              )}
            `
          : nothing}

        <!-- Friends, online first -->
        ${this.friends.length === 0
          ? html`<div class="px-2.5 py-4 lt-label !text-[10px] !text-lt-500">
              ${translateText("friends.no_friends")}
            </div>`
          : [...this.friends]
              .sort(
                (a, b) => Number(b.online === true) - Number(a.online === true),
              )
              .map(
                (friend) => html`
                  <button
                    class="w-full flex items-center gap-2 px-2.5 py-2 border-b border-lt-700/45 lt-row cursor-pointer text-left"
                    @click=${() => void this.openChat(friend.publicId)}
                  >
                    <span
                      class="w-2 h-2 shrink-0 rounded-full ${friend.online ===
                      true
                        ? "bg-lt-ok"
                        : "bg-lt-600"}"
                    ></span>
                    <span
                      class="flex-1 min-w-0 truncate text-[13px] ${friend.online ===
                      true
                        ? "text-lt-100"
                        : "text-lt-400"}"
                      >${this.nameOf(friend)}</span
                    >
                    ${(this.unread.get(friend.publicId) ?? 0) > 0
                      ? html`<span
                          class="lt-num min-w-[18px] h-[16px] px-1 grid place-items-center bg-lt-accent text-lt-accent-ink text-[11px] font-bold"
                          >${this.unread.get(friend.publicId)}</span
                        >`
                      : nothing}
                  </button>
                `,
              )}
      </div>
    `;
  }

  private renderChat() {
    const friend = this.friends.find((f) => f.publicId === this.activeChat);
    const me = this.myPublicId();

    return html`
      <div class="flex items-center gap-2 px-2.5 py-2 border-b border-lt-700">
        <button
          class="text-lt-400 hover:text-lt-100 cursor-pointer"
          aria-label="back"
          @click=${() => {
            this.activeChat = null;
            this.messages = [];
          }}
        >
          ←
        </button>
        <span
          class="w-2 h-2 shrink-0 rounded-full ${friend?.online === true
            ? "bg-lt-ok"
            : "bg-lt-600"}"
        ></span>
        <span class="flex-1 min-w-0 truncate text-[13px] text-lt-100"
          >${friend ? this.nameOf(friend) : (this.activeChat ?? "")}</span
        >
      </div>

      <div class="friends-chat-scroll flex-1 overflow-y-auto px-2.5 py-2">
        ${this.messages.length === 0
          ? html`<div class="lt-label !text-[10px] !text-lt-500 py-2">
              ${translateText("friends.no_messages")}
            </div>`
          : this.messages.map(
              (message) => html`
                <div
                  class="flex ${message.from === me
                    ? "justify-end"
                    : "justify-start"} mb-1.5"
                >
                  <span
                    class="max-w-[85%] px-2 py-1 text-[13px] leading-snug break-words ${message.from ===
                    me
                      ? "bg-lt-accent/15 border border-lt-accent/35 text-lt-100"
                      : "bg-lt-800 border border-lt-700 text-lt-100"}"
                    >${message.body}</span
                  >
                </div>
              `,
            )}
      </div>

      <form
        class="flex gap-1 p-2 border-t border-lt-700"
        @submit=${(e: Event) => void this.handleSendMessage(e)}
      >
        <input
          class="friends-chat-input flex-1 min-w-0 bg-lt-800 border border-lt-600 px-2 py-1 text-[13px] text-lt-100 placeholder:text-lt-500 outline-none focus:border-lt-accent"
          maxlength="500"
          placeholder=${translateText("friends.chat_placeholder")}
          autocomplete="off"
        />
        <button class="lt-btn-primary !py-1 !px-3 text-[12px]" type="submit">
          ${translateText("friends.send")}
        </button>
      </form>
    `;
  }
}
