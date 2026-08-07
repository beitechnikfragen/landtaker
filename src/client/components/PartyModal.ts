import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { isVerifiedUsername } from "../../core/ApiSchemas";
import { GameEnv } from "../../core/configuration/Config";
import type { Party } from "../../core/PartyApiSchemas";
import { ClientEnv } from "../ClientEnv";
import {
  connectPartyStream,
  createParty,
  devSignIn,
  fetchMyParty,
  joinParty,
  kickFromParty,
  leaveParty,
  type PartyActionError,
  type PartyStreamHandle,
} from "../PartyApi";
import { translateText } from "../Utils";
import { BaseModal } from "./BaseModal";
import { modalHeader } from "./ui/ModalHeader";
import { verifiedBadge } from "./ui/VerifiedBadge";

/**
 * Party UI: create a party, share the invite code, see who is in, leave.
 *
 * State is server-driven, never patched locally. While the modal is open it
 * subscribes to GET /parties/@me/events and renders straight from the pushed
 * payload, so a member joining elsewhere appears immediately.
 *
 * The 5s poll is kept as a fallback, not as the primary path: it runs only
 * until the stream reports itself live, and comes back if the stream cannot be
 * established (older backend without the route, a proxy that blocks SSE, a
 * signed-out viewer). A backend that cannot stream therefore still works
 * exactly as it did before.
 */
@customElement("party-modal")
export class PartyModal extends BaseModal {
  protected routerName = "party";

  @state() private party: Party | null = null;
  @state() private loading = true;
  @state() private busy = false;
  @state() private errorMessage: string | null = null;
  @state() private joinCode = "";
  @state() private copied = false;
  /** Set when the API reports 401 — parties require an account. */
  @state() private needsSignIn = false;
  /** Name typed into the dev-only sign-in box. */
  @state() private devName = "Boss";

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private stream: PartyStreamHandle | null = null;

  constructor() {
    super();
    this.id = "page-party";
  }

  disconnectedCallback() {
    // Both, not just the poll: a leaked stream reconnects on its own and would
    // outlive the element forever.
    this.teardownUpdates();
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    super.disconnectedCallback();
  }

  /** BaseModal calls these once the shell has opened/closed. */
  protected override onOpen(): void {
    this.errorMessage = null;
    void this.refresh();
    // Poll from the start so the modal is never dead while the stream is still
    // connecting; startStream() stands it down as soon as the stream is live.
    this.startPolling();
    this.startStream();
  }

  protected override onClose(): void {
    this.teardownUpdates();
  }

  /** Drops both update paths. Safe to call repeatedly. */
  private teardownUpdates() {
    this.stopPolling();
    this.stopStream();
  }

  /**
   * Subscribes to the live stream. Exactly one connection at a time: any
   * previous handle is closed first, so re-opening the modal cannot stack
   * subscriptions.
   */
  private startStream() {
    this.stopStream();
    const handle = connectPartyStream({
      onOpen: () => {
        // Ignore a late callback from a connection we already replaced.
        if (this.stream !== handle) return;
        // Live updates supersede the poll — this is the whole point.
        this.stopPolling();
      },
      onEvent: ({ party }) => {
        if (this.stream !== handle) return;
        // Server-authoritative, including `party: null` for a viewer who was
        // kicked or whose party was deleted — render create/join, never a
        // stale roster.
        this.party = party;
        this.needsSignIn = false;
        this.loading = false;
      },
      onDisconnect: () => {
        if (this.stream !== handle) return;
        // The stream is retrying (server restarted, network blip). It is not
        // delivering meanwhile, so poll until it reports itself live again —
        // otherwise the roster silently freezes.
        if (!this.needsSignIn && this.isOpen()) this.startPolling();
      },
      onFailure: () => {
        if (this.stream !== handle) return;
        // No live channel available. Fall back rather than showing a screen
        // that will never update.
        this.stream = null;
        if (!this.needsSignIn && this.isOpen()) this.startPolling();
      },
    });
    this.stream = handle;
  }

  private stopStream() {
    this.stream?.close();
    this.stream = null;
  }

  /** Poll only while visible — a background tab should not hammer the API. */
  private startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.refresh(), 5000);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async refresh() {
    const result = await fetchMyParty();
    if (result.ok) {
      this.party = result.value;
      this.needsSignIn = false;
    } else if (result.error === "unauthenticated") {
      // Parties are account-bound, so a signed-out visitor gets told that
      // rather than a create button that can only fail. Stop the stream too:
      // it would retry against a route that can only 401.
      this.needsSignIn = true;
      this.party = null;
      this.teardownUpdates();
    }
    // Any other failure leaves the last known state on screen; the poll will
    // pick it up again once the request succeeds.
    this.loading = false;
  }

  /**
   * Maps an error code to a human message. Falling back to a generic string
   * keeps an unknown code from rendering as a raw identifier.
   */
  private messageFor(error: PartyActionError): string {
    const key =
      {
        already_in_party: "party.error_already_in_party",
        party_full: "party.error_full",
        not_found: "party.error_not_found",
        not_a_member: "party.error_not_a_member",
        not_leader: "party.error_not_leader",
        closed: "party.error_closed",
        unauthenticated: "party.sign_in_required",
        request_failed: "party.error_request_failed",
      }[error] ?? "party.error_request_failed";
    return translateText(key);
  }

  private async run<T>(
    action: () => Promise<
      { ok: true; value: T } | { ok: false; error: PartyActionError }
    >,
  ) {
    if (this.busy) return;
    this.busy = true;
    this.errorMessage = null;
    try {
      const result = await action();
      if (result.ok) {
        await this.refresh();
        // Rebind the stream to the party we are now in.
        //
        // The backend subscribes to whichever party the viewer had AT CONNECT
        // TIME, and to nothing at all when they had none (see the comment in
        // backend/src/routes/partyEvents.ts). A stream opened on the
        // create/join screen is therefore watching nothing, and would never
        // report a later joiner. Reconnecting after a membership change is
        // what makes the subscription follow us — verified: without this, a
        // party created after the stream opened receives no live updates.
        if (this.isOpen()) this.startStream();
      } else {
        this.errorMessage = this.messageFor(result.error);
      }
    } finally {
      this.busy = false;
    }
  }

  private handleCreate = () => void this.run(() => createParty());

  private handleJoin = () => {
    const code = this.joinCode.trim();
    if (code.length < 4) return;
    void this.run(async () => {
      const result = await joinParty(code);
      if (result.ok) this.joinCode = "";
      return result;
    });
  };

  private handleLeave = () =>
    void this.run(async () => {
      const result = await leaveParty();
      // The party may be gone entirely; either way we are out of it.
      if (result.ok) this.party = null;
      return result;
    });

  private handleKick = (userId: string) =>
    void this.run(() => kickFromParty(userId));

  private handleCopyCode = async () => {
    if (!this.party) return;
    try {
      await navigator.clipboard.writeText(this.party.inviteCode);
      this.copied = true;
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        this.copied = false;
      }, 2000);
    } catch {
      // Clipboard access can be denied; the code is on screen to type anyway.
      this.errorMessage = translateText("party.error_copy_failed");
    }
  };

  /**
   * True when the caller leads this party. `viewerId` comes from the server —
   * absent (older backend) means no leader controls, which fails safe.
   */
  private viewerIsLeader(): boolean {
    const party = this.party;
    if (!party?.viewerId) return false;
    return party.leaderId === party.viewerId;
  }

  private renderMember(member: Party["members"][number]): TemplateResult {
    const canKick = this.viewerIsLeader() && !member.isLeader;
    const name = member.username ?? translateText("party.unnamed_player");
    return html`
      <li class="flex items-center gap-2 bg-white/5 px-3 py-2 text-lt-100">
        <span class="truncate">${name}</span>
        ${isVerifiedUsername(member.username) ? verifiedBadge() : ""}
        ${member.isLeader
          ? html`<span
              class="bg-lt-accent/20 px-1.5 py-0.5 text-xs text-blue-200"
              >${translateText("party.leader")}</span
            >`
          : ""}
        <span class="flex-1"></span>
        ${canKick
          ? html`<button
              class="px-2 py-1 text-xs text-lt-bad hover:bg-lt-bad/20 disabled:opacity-50"
              ?disabled=${this.busy}
              @click=${() => this.handleKick(member.userId)}
            >
              ${translateText("party.kick")}
            </button>`
          : ""}
      </li>
    `;
  }

  private renderSignIn(): TemplateResult {
    return html`
      <p class="mb-2 text-lt-100">${translateText("party.sign_in_required")}</p>
      <p class="text-sm text-lt-400">${translateText("party.sign_in_hint")}</p>
      ${this.renderDevSignIn()}
    `;
  }

  /**
   * Dev-only shortcut so parties can be exercised before OAuth exists. Hidden
   * outside development, and the backend route it calls is not registered in
   * production either.
   */
  private renderDevSignIn(): TemplateResult {
    if (ClientEnv.env() !== GameEnv.Dev) return html``;
    return html`
      <div class="mt-6 border border-yellow-500/30 bg-yellow-500/10 p-3">
        <p class="mb-2 text-xs text-yellow-200/80">
          ${translateText("party.dev_sign_in_note")}
        </p>
        <div class="flex gap-2">
          <input
            class="flex-1 bg-black/30 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-yellow-500"
            maxlength="24"
            placeholder="Boss"
            .value=${this.devName}
            @input=${(e: Event) => {
              this.devName = (e.target as HTMLInputElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") this.handleDevSignIn();
            }}
          />
          <button
            class="bg-yellow-600/80 px-4 py-2 font-semibold text-white hover:bg-yellow-600 disabled:opacity-50"
            ?disabled=${this.busy || this.devName.trim().length < 3}
            @click=${this.handleDevSignIn}
          >
            ${translateText("party.dev_sign_in")}
          </button>
        </div>
      </div>
    `;
  }

  private handleDevSignIn = async () => {
    const name = this.devName.trim();
    if (name.length < 3 || this.busy) return;
    this.busy = true;
    const ok = await devSignIn(name);
    if (ok) {
      // The client caches its JWT at startup, so a session created now is only
      // picked up on the next load.
      location.reload();
    } else {
      this.busy = false;
      this.errorMessage = translateText("party.error_request_failed");
    }
  };

  private renderNoParty(): TemplateResult {
    return html`
      <p class="mb-4 text-sm text-lt-400">${translateText("party.intro")}</p>

      <button
        class="mb-6 w-full bg-lt-accent px-4 py-2 font-semibold text-white hover:bg-lt-accent-hi disabled:opacity-50"
        ?disabled=${this.busy}
        @click=${this.handleCreate}
      >
        ${translateText("party.create")}
      </button>

      <label class="mb-2 block text-sm text-lt-400">
        ${translateText("party.join_label")}
      </label>
      <div class="flex gap-2">
        <input
          class="flex-1 bg-black/30 px-3 py-2 uppercase tracking-widest text-white outline-none focus:ring-2 focus:ring-blue-500"
          maxlength="12"
          placeholder="ABC123"
          .value=${this.joinCode}
          ?disabled=${this.busy}
          @input=${(e: Event) => {
            this.joinCode = (e.target as HTMLInputElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") this.handleJoin();
          }}
        />
        <button
          class="bg-white/10 px-4 py-2 font-semibold text-white hover:bg-white/20 disabled:opacity-50"
          ?disabled=${this.busy || this.joinCode.trim().length < 4}
          @click=${this.handleJoin}
        >
          ${translateText("party.join")}
        </button>
      </div>
    `;
  }

  private renderParty(party: Party): TemplateResult {
    return html`
      <div class="mb-4">
        <div class="mb-1 text-sm text-lt-400">
          ${translateText("party.invite_code")}
        </div>
        <button
          class="flex w-full items-center justify-between bg-black/30 px-4 py-3 text-left hover:bg-black/40"
          @click=${this.handleCopyCode}
        >
          <span class="text-2xl font-bold tracking-[0.3em] text-white"
            >${party.inviteCode}</span
          >
          <span class="text-xs text-lt-400">
            ${this.copied
              ? translateText("party.copied")
              : translateText("party.copy")}
          </span>
        </button>
      </div>

      <div class="mb-2 flex items-center justify-between text-sm text-lt-400">
        <span>${translateText("party.members")}</span>
        <span>${party.members.length} / ${party.maxMembers}</span>
      </div>
      <ul class="mb-6 flex flex-col gap-1">
        ${party.members.map((m) => this.renderMember(m))}
      </ul>

      <button
        class="w-full bg-lt-bad/80 px-4 py-2 font-semibold text-white hover:bg-lt-bad disabled:opacity-50"
        ?disabled=${this.busy}
        @click=${this.handleLeave}
      >
        ${translateText("party.leave")}
      </button>
    `;
  }

  createRenderRoot() {
    return this;
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("party.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  /**
   * BaseModal owns the <o-modal> shell; subclasses supply only its contents.
   * Rendering a second <o-modal> from render() leaves it closed — inline pages
   * never get the `open` attribute — which collapses the element to 0x0 and
   * makes the page look blank.
   */
  protected renderBody(): TemplateResult {
    return html`
      <div class="custom-scrollbar p-6">
        ${this.errorMessage && !this.needsSignIn
          ? html`<div class="mb-4 bg-red-500/20 px-3 py-2 text-sm text-red-200">
              ${this.errorMessage}
            </div>`
          : ""}
        ${this.loading
          ? html`<p class="text-lt-400">${translateText("party.loading")}</p>`
          : this.needsSignIn
            ? this.renderSignIn()
            : this.party
              ? this.renderParty(this.party)
              : this.renderNoParty()}
      </div>
    `;
  }
}
