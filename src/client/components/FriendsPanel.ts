import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  FriendEntry,
  FriendMessage,
  FriendStreamEvent,
  UserMeResponse,
} from "../../core/ApiSchemas";
import { Party } from "../../core/PartyApiSchemas";
import { hasLinkedAccount } from "../Api";
import {
  acceptFriendRequest,
  connectFriendsStream,
  deleteFriendRequest,
  fetchFriendRequests,
  fetchFriends,
  fetchMessages,
  type FriendsStreamHandle,
  sendChatMessage,
  sendFriendRequest,
} from "../FriendsApi";
import {
  connectPartyStream,
  createParty,
  invitePartyMember,
  joinParty,
  kickFromParty,
  leaveParty,
  type PartyStreamHandle,
  sendPartyChat,
} from "../PartyApi";
import { translateText } from "../Utils";

/** One party-chat line as the panel keeps it. Ephemeral, never persisted. */
interface PartyChatLine {
  from: string;
  username: string | null;
  body: string;
  createdAt: string;
}

/** Cap the in-memory party chat; older lines scroll out of existence. */
const PARTY_CHAT_CAP = 100;

/**
 * How often the friends list and incoming requests are re-fetched.
 *
 * The event stream carries messages, presence and party traffic, but the API
 * emits nothing when a friendship itself changes — so someone adding you, or
 * accepting the request you sent, would otherwise stay invisible until a
 * reload. This poll is what makes those appear on their own. Drop it the day
 * the backend gains a friendship event.
 */
const ROSTER_POLL_MS = 15_000;

/** A pending "join my party" invite from a friend, newest per sender wins. */
interface PartyInvite {
  from: string;
  username: string | null;
  inviteCode: string;
  createdAt: string;
}

/**
 * The always-there social dock: a collapsible panel pinned to the bottom-right
 * of every main-menu page (hidden in game, where the HUD owns the screen).
 *
 * Two tabs: FRIENDS (list, requests, 1:1 chat) and PARTY (roster, invite
 * code, party chat). Presence, direct messages and party chat all arrive over
 * ONE SSE stream (connectFriendsStream); the party roster additionally rides
 * the existing party stream so leader changes and joins appear live.
 */
@customElement("friends-panel")
export class FriendsPanel extends LitElement {
  @state() private userMeResponse: UserMeResponse | false = false;
  @state() private open = localStorage.getItem("friendsPanelOpen") === "1";
  @state() private tab: "friends" | "party" = "friends";
  @state() private friends: FriendEntry[] = [];
  @state() private incoming: FriendEntry[] = [];
  @state() private unread: Map<string, number> = new Map();
  /** publicId of the open conversation, or null for the list view. */
  @state() private activeChat: string | null = null;
  @state() private messages: FriendMessage[] = [];
  @state() private addValue = "";
  @state() private addNote: string | null = null;

  @state() private party: Party | null = null;
  @state() private partyMessages: PartyChatLine[] = [];
  @state() private partyUnread = 0;
  @state() private joinCode = "";
  @state() private partyNote: string | null = null;
  @state() private codeCopied = false;
  @state() private partyInvites: PartyInvite[] = [];
  /** Friends already invited this session, for the "Invited" feedback. */
  @state() private invitedFriends: Set<string> = new Set();
  @state() private idCopied = false;

  private stream: FriendsStreamHandle | null = null;
  private partyStream: PartyStreamHandle | null = null;
  private rosterTimer: ReturnType<typeof setInterval> | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("userMeResponse", this.onUserMe as EventListener);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  disconnectedCallback() {
    document.removeEventListener(
      "userMeResponse",
      this.onUserMe as EventListener,
    );
    document.removeEventListener("visibilitychange", this.onVisibility);
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
    this.connectPartyStream();
    this.startRosterPoll();
  }

  private startRosterPoll() {
    if (this.rosterTimer !== null) return;
    this.rosterTimer = setInterval(() => {
      // Nothing to see on a backgrounded tab, and the visibility handler
      // refreshes immediately on return — so skip rather than burn a request.
      if (document.hidden) return;
      void this.refresh();
    }, ROSTER_POLL_MS);
  }

  /** Back on screen: catch up at once instead of waiting out the interval. */
  private onVisibility = () => {
    if (!document.hidden && this.linked()) void this.refresh();
  };

  /**
   * (Re)opens the roster stream. The backend only subscribes the stream to
   * the party that exists WHEN IT CONNECTS, so every create/join/leave from
   * this panel reconnects to pick up the new subscription.
   */
  private connectPartyStream() {
    this.partyStream?.close();
    this.partyStream = connectPartyStream({
      onEvent: (event) => {
        this.party = event.party;
        if (event.party === null) {
          this.partyMessages = [];
          this.partyUnread = 0;
        }
      },
      onFailure: () => {},
    });
  }

  private teardown() {
    this.stream?.close();
    this.stream = null;
    this.partyStream?.close();
    this.partyStream = null;
    if (this.rosterTimer !== null) {
      clearInterval(this.rosterTimer);
      this.rosterTimer = null;
    }
    this.friends = [];
    this.incoming = [];
    this.unread = new Map();
    this.activeChat = null;
    this.messages = [];
    this.party = null;
    this.partyMessages = [];
    this.partyUnread = 0;
  }

  private async refresh() {
    const [friends, requests] = await Promise.all([
      fetchFriends(1, 100),
      fetchFriendRequests(),
    ]);
    if (friends !== false) {
      // GET /friends carries presence, but a response that omits it must not
      // erase what the stream already told us about that friend.
      const known = new Map(this.friends.map((f) => [f.publicId, f.online]));
      this.friends = friends.results.map((friend) =>
        friend.online === undefined
          ? { ...friend, online: known.get(friend.publicId) }
          : friend,
      );
    }
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

    if (event.type === "party_message") {
      this.partyMessages = [...this.partyMessages, event].slice(
        -PARTY_CHAT_CAP,
      );
      const watching = this.open && this.tab === "party";
      if (!watching && event.from !== this.myPublicId()) this.partyUnread++;
      if (watching) this.scrollDown(".party-chat-scroll");
      return;
    }

    if (event.type === "party_invite") {
      if (event.from === this.myPublicId()) return;
      // Newest invite per sender wins; a spammed friend still shows one card.
      this.partyInvites = [
        ...this.partyInvites.filter((invite) => invite.from !== event.from),
        event,
      ];
      return;
    }

    if (event.type === "party_join") {
      this.followLeaderIntoLobby(event.gameId, event.source);
      return;
    }

    // A direct message. Identify the other party: for our own echoed sends
    // that's the recipient, otherwise the sender.
    const mine = event.message.from === this.myPublicId();
    const other = mine ? event.message.to : event.message.from;

    if (this.activeChat === other && this.open && this.tab === "friends") {
      if (!this.messages.some((m) => m.id === event.message.id)) {
        this.messages = [...this.messages, event.message];
        this.scrollDown(".friends-chat-scroll");
      }
      return;
    }
    if (!mine) {
      const next = new Map(this.unread);
      next.set(other, (next.get(other) ?? 0) + 1);
      this.unread = next;
      if (!this.friends.some((f) => f.publicId === other)) void this.refresh();
    }
  }

  /**
   * The leader entered a lobby — go there too.
   *
   * Dispatched as the same `join-lobby` event the lobby cards fire, so the
   * follower takes the identical code path (Main.handleJoinLobby). `followed`
   * stops that handler from re-broadcasting, which would otherwise ping-pong
   * the join around the party.
   *
   * Ignored while already in a game: yanking someone out of a running match
   * because a teammate queued elsewhere would be worse than not following.
   */
  private followLeaderIntoLobby(
    gameId: string,
    source: "public" | "private" | "host" | "matchmaking",
  ) {
    if (document.body.classList.contains("in-game")) return;

    document.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: { gameID: gameId, source, followed: true },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleOpen() {
    this.open = !this.open;
    localStorage.setItem("friendsPanelOpen", this.open ? "1" : "0");
    if (this.open && this.tab === "party") this.partyUnread = 0;
  }

  private switchTab(tab: "friends" | "party") {
    this.tab = tab;
    if (tab === "party") {
      this.partyUnread = 0;
      this.scrollDown(".party-chat-scroll");
    }
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
      this.scrollDown(".friends-chat-scroll");
    }
  }

  private scrollDown(selector: string) {
    requestAnimationFrame(() => {
      const el = this.querySelector(selector);
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
      this.scrollDown(".friends-chat-scroll");
    }
  }

  private async handleSendPartyChat(e: Event) {
    e.preventDefault();
    const input = this.querySelector(
      ".party-chat-input",
    ) as HTMLInputElement | null;
    const body = input?.value.trim() ?? "";
    if (body.length === 0) return;
    if (input) input.value = "";
    // The echo arrives on our own stream; nothing is appended here, so the
    // line shows exactly what every member received.
    await sendPartyChat(body);
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

  private async handleCreateParty() {
    this.partyNote = null;
    const result = await createParty();
    if (result.ok) {
      this.party = result.value;
      this.connectPartyStream();
    } else {
      this.partyNote = translateText("party.error_generic");
    }
  }

  private async handleJoinParty(e: Event) {
    e.preventDefault();
    const code = this.joinCode.trim();
    if (code.length === 0) return;
    this.partyNote = null;
    const result = await joinParty(code);
    if (result.ok) {
      this.party = result.value;
      this.joinCode = "";
      this.connectPartyStream();
    } else {
      this.partyNote = translateText(
        result.error === "not_found"
          ? "party.error_not_found"
          : result.error === "party_full"
            ? "party.error_full"
            : result.error === "closed"
              ? "party.error_closed"
              : "party.error_generic",
      );
    }
  }

  private async handleLeaveParty() {
    await leaveParty();
    this.party = null;
    this.partyMessages = [];
    this.partyUnread = 0;
    this.connectPartyStream();
  }

  private async handleKick(userId: string) {
    const result = await kickFromParty(userId);
    if (result.ok) this.party = result.value;
  }

  /** Sends a direct party invite to one friend, with inline feedback. */
  private async handleInviteFriend(publicId: string) {
    const ok = await invitePartyMember(publicId);
    if (ok) {
      const next = new Set(this.invitedFriends);
      next.add(publicId);
      this.invitedFriends = next;
    }
  }

  /** Accepting an invite is an ordinary join with the carried code. */
  private async handleAcceptInvite(invite: PartyInvite) {
    this.partyInvites = this.partyInvites.filter(
      (candidate) => candidate.from !== invite.from,
    );
    const result = await joinParty(invite.inviteCode);
    if (result.ok) {
      this.party = result.value;
      this.partyNote = null;
      this.connectPartyStream();
      this.switchTab("party");
    } else {
      this.tab = "party";
      this.partyNote = translateText(
        result.error === "not_found"
          ? "party.error_not_found"
          : result.error === "party_full"
            ? "party.error_full"
            : result.error === "already_in_party"
              ? "party.error_already_in_party"
              : "party.error_generic",
      );
    }
  }

  private dismissInvite(invite: PartyInvite) {
    this.partyInvites = this.partyInvites.filter(
      (candidate) => candidate.from !== invite.from,
    );
  }

  /** The pending invite cards, shown on both tabs so they can't be missed. */
  private renderInviteCards() {
    return this.partyInvites.map(
      (invite) => html`
        <div
          class="flex items-center gap-2 px-2.5 py-2 border-b border-lt-700 bg-lt-accent/10 [box-shadow:inset_2px_0_0_var(--color-lt-accent)]"
        >
          <span class="flex-1 min-w-0 text-[14px] text-lt-100 leading-snug"
            >${translateText("party.invites_you", {
              name: invite.username ?? invite.from,
            })}</span
          >
          <button
            class="lt-num text-[12px] font-bold uppercase bg-lt-accent text-lt-accent-ink px-2 py-0.5 hover:bg-lt-accent-hi cursor-pointer"
            @click=${() => void this.handleAcceptInvite(invite)}
          >
            ${translateText("party.join")}
          </button>
          <button
            class="text-lt-500 hover:text-lt-100 cursor-pointer px-1"
            aria-label=${translateText("party.dismiss")}
            title=${translateText("party.dismiss")}
            @click=${() => this.dismissInvite(invite)}
          >
            ✕
          </button>
        </div>
      `,
    );
  }

  private copyOwnId() {
    const id = this.myPublicId();
    if (id.length === 0) return;
    void navigator.clipboard?.writeText(id).then(() => {
      this.idCopied = true;
      setTimeout(() => (this.idCopied = false), 1500);
    });
  }

  private copyInviteCode() {
    if (this.party === null) return;
    void navigator.clipboard?.writeText(this.party.inviteCode).then(() => {
      this.codeCopied = true;
      setTimeout(() => (this.codeCopied = false), 1500);
    });
  }

  private nameOf(entry: { username?: string | null; publicId: string }) {
    return entry.username ?? entry.publicId;
  }

  private unreadTotal(): number {
    let sum = this.partyUnread;
    for (const n of this.unread.values()) sum += n;
    return sum;
  }

  render() {
    if (!this.linked()) return nothing;

    const onlineCount = this.friends.filter((f) => f.online === true).length;
    const unreadTotal = this.unreadTotal();

    return html`
      <div
        class="hidden lg:block in-[.in-game]:!hidden fixed bottom-0 right-[72px] z-[900] w-[340px] pointer-events-auto"
      >
        <!-- Collapsed bar / panel header -->
        <button
          class="w-full flex items-center gap-2 px-3 h-[38px] bg-[rgb(11_14_17/0.96)] border border-lt-700 ${this
            .open
            ? "border-b-0"
            : ""} cursor-pointer"
          @click=${() => this.toggleOpen()}
        >
          <span class="lt-label !text-[12px] !text-lt-100"
            >${translateText("friends.social")}</span
          >
          <span class="lt-label !text-[11px]"
            >${onlineCount}/${this.friends.length}
            ${translateText("friends.online")}</span
          >
          ${this.party !== null
            ? html`<span class="lt-label !text-[11px] !text-lt-accent"
                >${translateText("party.title")}
                ${this.party.members.length}/${this.party.maxMembers}</span
              >`
            : nothing}
          ${unreadTotal > 0
            ? html`<span
                class="lt-num min-w-[18px] h-[16px] px-1 grid place-items-center bg-lt-accent text-lt-accent-ink text-[11px] font-bold"
                >${unreadTotal}</span
              >`
            : nothing}
          ${this.incoming.length + this.partyInvites.length > 0
            ? html`<span
                class="lt-num min-w-[18px] h-[16px] px-1 grid place-items-center border border-lt-accent/60 text-lt-accent text-[11px] font-bold"
                >${this.incoming.length + this.partyInvites.length}</span
              >`
            : nothing}
          <span class="ml-auto text-lt-400" aria-hidden="true"
            >${this.open ? "▾" : "▴"}</span
          >
        </button>

        ${this.open
          ? html`<div
              class="bg-[rgb(11_14_17/0.96)] border border-lt-700 flex flex-col h-[460px]"
            >
              <!-- Tabs -->
              <div class="flex border-b border-lt-700 shrink-0">
                ${(["friends", "party"] as const).map(
                  (tab) => html`
                    <button
                      class="flex-1 flex items-center justify-center gap-1.5 py-2 lt-label !text-[12px] cursor-pointer ${this
                        .tab === tab
                        ? "!text-lt-accent [box-shadow:inset_0_-2px_0_var(--color-lt-accent)]"
                        : "hover:!text-lt-100"}"
                      @click=${() => this.switchTab(tab)}
                    >
                      ${translateText(
                        tab === "friends" ? "friends.title" : "party.title",
                      )}
                      ${tab === "party" && this.partyUnread > 0
                        ? html`<span
                            class="lt-num min-w-[16px] h-[14px] px-0.5 grid place-items-center bg-lt-accent text-lt-accent-ink text-[10px] font-bold"
                            >${this.partyUnread}</span
                          >`
                        : nothing}
                    </button>
                  `,
                )}
              </div>
              <!-- Party invites float above whatever view is open. -->
              ${this.renderInviteCards()}
              ${this.tab === "party"
                ? this.renderParty()
                : this.activeChat !== null
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
          class="flex-1 min-w-0 bg-lt-800 border border-lt-600 px-2.5 py-1.5 text-[14px] text-lt-100 placeholder:text-lt-500 outline-none focus:border-lt-accent"
          .value=${this.addValue}
          @input=${(e: Event) => {
            this.addValue = (e.target as HTMLInputElement).value;
            this.addNote = null;
          }}
          placeholder=${translateText("friends.public_id_placeholder")}
        />
        <!-- Accent plus square: the primary action of this row, without a
             full-width word eating the input's space. -->
        <button
          class="shrink-0 w-[34px] grid place-items-center bg-lt-accent text-lt-accent-ink hover:bg-lt-accent-hi transition-colors cursor-pointer"
          type="submit"
          title=${translateText("friends.add_friend")}
          aria-label=${translateText("friends.add_friend")}
        >
          <svg
            viewBox="0 0 24 24"
            class="w-4.5 h-4.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </form>
      ${this.addNote !== null
        ? html`<div class="px-2.5 py-1 lt-label !text-[11px] !text-lt-400">
            ${this.addNote}
          </div>`
        : nothing}

      <!-- Your own id, one click to copy — it's the only way friends can
           add you, so it must never need hunting. -->
      <div class="flex items-center gap-2 px-2.5 py-1.5 border-b border-lt-700">
        <span class="lt-label !text-[11px] shrink-0"
          >${translateText("friends.your_id")}</span
        >
        <button
          class="lt-num text-[13px] text-lt-accent tracking-[0.06em] truncate cursor-pointer hover:text-lt-accent-hi"
          title=${translateText("friends.copy_id")}
          @click=${() => this.copyOwnId()}
        >
          ${this.myPublicId()}
        </button>
        ${this.idCopied
          ? html`<span class="lt-label !text-[10px] !text-lt-ok shrink-0"
              >${translateText("party.copied")}</span
            >`
          : html`<svg
              viewBox="0 0 24 24"
              class="w-3.5 h-3.5 shrink-0 text-lt-500"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="11" height="11" rx="0" />
              <path d="M5 15V5a1 1 0 0 1 1-1h10" />
            </svg>`}
      </div>

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
                      class="flex-1 min-w-0 truncate text-[14px] text-lt-100"
                      >${this.nameOf(request)}</span
                    >
                    <button
                      class="lt-label !text-[11px] border border-lt-600 px-1.5 py-px hover:!text-lt-ok hover:border-lt-ok/50"
                      @click=${() =>
                        void this.handleRequest(request.publicId, true)}
                    >
                      ${translateText("friends.accept")}
                    </button>
                    <button
                      class="lt-label !text-[11px] border border-lt-600 px-1.5 py-px hover:!text-lt-bad hover:border-lt-bad/50"
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
          ? html`<div class="px-2.5 py-4 lt-label !text-[11px] !text-lt-500">
              ${translateText("friends.no_friends")}
            </div>`
          : [...this.friends]
              .sort(
                (a, b) => Number(b.online === true) - Number(a.online === true),
              )
              .map((friend) => {
                const unreadCount = this.unread.get(friend.publicId) ?? 0;
                // Party invite action only when there IS a party to invite
                // into and the friend isn't already sitting in it.
                const canInvite =
                  this.party !== null &&
                  !this.party.members.some(
                    (member) => member.publicId === friend.publicId,
                  );
                const alreadyInvited = this.invitedFriends.has(friend.publicId);
                return html`
                  <div
                    class="flex items-center gap-2 px-2.5 border-b border-lt-700/45 ${unreadCount >
                    0
                      ? "bg-lt-accent/10 [box-shadow:inset_2px_0_0_var(--color-lt-accent)] hover:bg-lt-accent/15"
                      : "lt-row"}"
                  >
                    <button
                      class="flex-1 min-w-0 flex items-center gap-2 py-2 cursor-pointer text-left"
                      @click=${() => void this.openChat(friend.publicId)}
                    >
                      <span
                        class="w-2 h-2 shrink-0 rounded-full ${friend.online ===
                        true
                          ? "bg-lt-ok"
                          : "bg-lt-600"}"
                      ></span>
                      <span
                        class="flex-1 min-w-0 truncate text-[14px] ${unreadCount >
                        0
                          ? "text-lt-100 font-semibold"
                          : friend.online === true
                            ? "text-lt-100"
                            : "text-lt-400"}"
                        >${this.nameOf(friend)}</span
                      >
                      ${unreadCount > 0
                        ? html`<span
                            class="lt-num min-w-[20px] h-[18px] px-1 grid place-items-center bg-lt-accent text-lt-accent-ink text-[12px] font-bold"
                            >${unreadCount}</span
                          >`
                        : nothing}
                    </button>
                    ${canInvite
                      ? alreadyInvited
                        ? html`<span class="lt-label !text-[10px] !text-lt-ok"
                            >${translateText("party.invited")}</span
                          >`
                        : html`<button
                            class="lt-label !text-[11px] border border-lt-600 px-1.5 py-px hover:!text-lt-accent hover:border-lt-accent/50 cursor-pointer shrink-0"
                            title=${translateText("party.invite")}
                            @click=${() =>
                              void this.handleInviteFriend(friend.publicId)}
                          >
                            ${translateText("party.invite")}
                          </button>`
                      : nothing}
                  </div>
                `;
              })}
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
        <span class="flex-1 min-w-0 truncate text-[14px] text-lt-100"
          >${friend ? this.nameOf(friend) : (this.activeChat ?? "")}</span
        >
      </div>

      <div class="friends-chat-scroll flex-1 overflow-y-auto px-2.5 py-2">
        ${this.messages.length === 0
          ? html`<div class="lt-label !text-[11px] !text-lt-500 py-2">
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
                    class="max-w-[85%] px-2 py-1 text-[14px] leading-snug break-words ${message.from ===
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
          class="friends-chat-input flex-1 min-w-0 bg-lt-800 border border-lt-600 px-2 py-1 text-[14px] text-lt-100 placeholder:text-lt-500 outline-none focus:border-lt-accent"
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

  private renderParty() {
    if (this.party === null) {
      return html`
        <div class="p-3 flex flex-col gap-2">
          <button
            class="lt-btn-primary w-full py-2 text-[14px]"
            @click=${() => void this.handleCreateParty()}
          >
            ${translateText("party.create")}
          </button>
          <div class="lt-rule my-1">
            <span class="lt-label !text-[10px]"
              >${translateText("party.or_join")}</span
            >
          </div>
          <form
            class="flex gap-1"
            @submit=${(e: Event) => void this.handleJoinParty(e)}
          >
            <input
              class="flex-1 min-w-0 bg-lt-800 border border-lt-600 px-2 py-1 text-[14px] text-lt-100 placeholder:text-lt-500 outline-none focus:border-lt-accent uppercase"
              .value=${this.joinCode}
              @input=${(e: Event) => {
                this.joinCode = (e.target as HTMLInputElement).value;
                this.partyNote = null;
              }}
              placeholder=${translateText("party.code_placeholder")}
            />
            <button class="lt-btn !py-1 !px-2.5 text-[12px]" type="submit">
              ${translateText("party.join")}
            </button>
          </form>
          ${this.partyNote !== null
            ? html`<div class="lt-label !text-[10px] !text-lt-bad">
                ${this.partyNote}
              </div>`
            : nothing}
        </div>
      `;
    }

    const me = this.myPublicId();
    const viewer = this.party.members.find((m) => m.publicId === me);
    const iAmLeader = viewer?.isLeader === true;

    return html`
      <!-- Invite code + leave -->
      <div class="flex items-center gap-2 px-2.5 py-2 border-b border-lt-700">
        <span class="lt-label !text-[11px]"
          >${translateText("party.invite_code")}</span
        >
        <button
          class="lt-num text-[14px] text-lt-accent tracking-[0.2em] cursor-pointer"
          title=${translateText("party.copy_code")}
          @click=${() => this.copyInviteCode()}
        >
          ${this.party.inviteCode}
        </button>
        ${this.codeCopied
          ? html`<span class="lt-label !text-[9px] !text-lt-ok"
              >${translateText("party.copied")}</span
            >`
          : nothing}
        <button
          class="ml-auto lt-label !text-[11px] border border-lt-600 px-1.5 py-px hover:!text-lt-bad hover:border-lt-bad/50"
          @click=${() => void this.handleLeaveParty()}
        >
          ${translateText("party.leave")}
        </button>
      </div>

      <!-- Roster -->
      <div
        class="border-b border-lt-700 shrink-0 max-h-[150px] overflow-y-auto"
      >
        ${this.party.members.map(
          (member) => html`
            <div
              class="flex items-center gap-2 px-2.5 py-1.5 border-b border-lt-700/45 last:border-b-0"
            >
              <span
                class="w-2 h-2 shrink-0 rounded-full ${member.isLeader
                  ? "bg-lt-accent"
                  : "bg-lt-ok"}"
                title=${member.isLeader ? translateText("party.leader") : ""}
              ></span>
              <span
                class="flex-1 min-w-0 truncate text-[14px] ${member.publicId ===
                me
                  ? "text-lt-accent"
                  : "text-lt-100"}"
                >${this.nameOf(member)}</span
              >
              ${member.isLeader
                ? html`<span class="lt-label !text-[9px] !text-lt-accent"
                    >${translateText("party.leader")}</span
                  >`
                : nothing}
              ${iAmLeader && member.publicId !== me
                ? html`<button
                    class="lt-label !text-[11px] border border-lt-600 px-1.5 py-px hover:!text-lt-bad hover:border-lt-bad/50"
                    @click=${() => void this.handleKick(member.userId)}
                  >
                    ${translateText("party.kick")}
                  </button>`
                : nothing}
            </div>
          `,
        )}
      </div>

      <!-- Party chat -->
      <div class="party-chat-scroll flex-1 overflow-y-auto px-2.5 py-2">
        ${this.partyMessages.length === 0
          ? html`<div class="lt-label !text-[11px] !text-lt-500 py-2">
              ${translateText("friends.no_messages")}
            </div>`
          : this.partyMessages.map(
              (line) => html`
                <div class="mb-1 text-[14px] leading-snug break-words">
                  <b
                    class="${line.from === me
                      ? "text-lt-accent"
                      : "text-lt-100"} font-semibold"
                    >${line.username ?? line.from}:</b
                  >
                  <span class="text-lt-100">${line.body}</span>
                </div>
              `,
            )}
      </div>

      <form
        class="flex gap-1 p-2 border-t border-lt-700"
        @submit=${(e: Event) => void this.handleSendPartyChat(e)}
      >
        <input
          class="party-chat-input flex-1 min-w-0 bg-lt-800 border border-lt-600 px-2 py-1 text-[14px] text-lt-100 placeholder:text-lt-500 outline-none focus:border-lt-accent"
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
