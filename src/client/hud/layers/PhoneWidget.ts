import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { PhoneMode } from "../../../core/Schemas";
import type { PhoneController } from "../../phone/PhoneController";
import { translateText } from "../../Utils";
import type { GameView, PlayerView } from "../../view";

// Red rotary telephone overlay. Never a modal: it never covers the whole
// screen, never traps focus, and never blocks pointer events on the map
// behind it. Two sizes — a small badge at the edge, and the full apparatus
// which an incoming call expands to automatically.
@customElement("phone-widget")
export class PhoneWidget extends LitElement {
  public controller: PhoneController | null = null;
  public game: GameView | null = null;

  @state() private expanded = false;
  @state() private tick = 0;

  private unsubscribe: (() => void) | null = null;
  private blocked = new Set<string>();

  createRenderRoot() {
    return this; // Disable shadow DOM to allow Tailwind styles
  }

  init(controller: PhoneController, game: GameView) {
    this.controller = controller;
    this.game = game;
    this.unsubscribe?.();
    this.unsubscribe = controller.machine.onChange(() => {
      // An incoming call flips the apparatus open by itself.
      if (controller.machine.state === "ringing") this.expanded = true;
      this.tick++;
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // Only real fellow players belong in the directory — no bots, no nations,
  // not yourself.
  private callables(): PlayerView[] {
    const me = this.game?.myPlayer();
    return (this.game?.playerViews() ?? []).filter(
      (p) => p.isPlayer() && p.clientID() !== null && p !== me,
    );
  }

  render() {
    if (!this.controller || !this.game) return html``;
    return this.expanded ? this.renderApparatus() : this.renderMini();
  }

  private renderMini() {
    const missed = this.controller!.machine.missed.length;
    const state = this.controller!.machine.state;
    const shaking = state === "ringing";
    return html`
      <div
        class="fixed bottom-24 right-4 z-50 cursor-pointer select-none"
        @click=${() => (this.expanded = true)}
        title=${translateText("phone.title")}
      >
        <div
          class="relative w-16 h-16 rounded-lg bg-red-700 border-2 border-red-900 shadow-lg flex items-center justify-center ${shaking
            ? "animate-bounce"
            : ""}"
        >
          <span class="text-3xl">☎️</span>
          ${missed > 0
            ? html`<span
                class="absolute -top-1 -right-1 bg-yellow-400 text-black text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center"
                >${missed}</span
              >`
            : ""}
        </div>
      </div>
    `;
  }

  private renderApparatus() {
    const m = this.controller!.machine;
    return html`
      <div
        class="fixed bottom-24 right-4 z-50 w-[min(28rem,90vw)] max-h-[60vh] overflow-y-auto rounded-xl bg-red-800 border-4 border-red-950 shadow-2xl text-white p-3"
      >
        <div class="flex items-center justify-between mb-2">
          <span class="font-bold">${translateText("phone.title")}</span>
          <button
            class="px-2 py-1 rounded bg-red-950 hover:bg-black"
            @click=${() => (this.expanded = false)}
          >
            ✕
          </button>
        </div>

        ${this.renderStatus()} ${this.renderModeSwitch()}
        ${m.state === "in-call" ? this.renderInCall() : this.renderDirectory()}
        ${this.renderMissed()} ${this.renderVolume()}
      </div>
    `;
  }

  private renderStatus() {
    const m = this.controller!.machine;
    const label = {
      idle: "",
      dialing: translateText("phone.calling"),
      ringing: translateText("phone.incoming_call"),
      "in-call": translateText("phone.in_call"),
      busy: translateText("phone.busy"),
    }[m.state];
    return html`
      ${label
        ? html`<div class="mb-2 p-2 rounded bg-red-950 flex items-center gap-2">
            <span class="font-semibold">${label}</span>
            ${m.state === "ringing" && m.incoming
              ? html`<span>${m.incoming.username}</span>
                  <button
                    class="ml-auto px-3 py-1 rounded bg-green-600 hover:bg-green-500"
                    @click=${() => this.controller!.answer()}
                  >
                    ${translateText("phone.call")}
                  </button>`
              : ""}
            ${m.state === "dialing" || m.state === "in-call"
              ? html`<button
                  class="ml-auto px-3 py-1 rounded bg-black hover:bg-gray-800"
                  @click=${() => this.controller!.hangup()}
                >
                  ${translateText("phone.hang_up")}
                </button>`
              : ""}
          </div>`
        : ""}
      ${this.controller!.micDenied
        ? html`<div class="mb-2 text-xs text-yellow-300">
            ${translateText("phone.mic_blocked")}
          </div>`
        : ""}
    `;
  }

  private renderModeSwitch() {
    const current = this.controller!.mode;
    const modes: Array<[PhoneMode, string]> = [
      ["normal", translateText("phone.normal")],
      ["silent", translateText("phone.silent")],
      ["dnd", translateText("phone.dnd")],
    ];
    return html`
      <div class="flex gap-1 mb-2">
        ${modes.map(
          ([value, label]) => html`
            <button
              class="flex-1 px-2 py-1 rounded text-xs ${current === value
                ? "bg-yellow-400 text-black font-bold"
                : "bg-red-950 hover:bg-black"}"
              @click=${() => {
                this.controller!.setMode(value);
                this.tick++;
              }}
            >
              ${label}
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderDirectory() {
    const players = this.callables();
    return html`
      <div class="flex flex-col gap-1">
        ${players.map((p) => {
          const id = p.clientID()!;
          const isBlocked = this.blocked.has(id);
          return html`
            <div class="flex items-center gap-1">
              <button
                class="flex-1 flex items-center gap-2 px-2 py-1 rounded bg-red-950 hover:bg-black text-left disabled:opacity-40"
                ?disabled=${isBlocked}
                @click=${() => this.controller!.dial(id)}
              >
                <span class="truncate">${p.displayName()}</span>
              </button>
              <button
                class="px-2 py-1 rounded text-xs ${isBlocked
                  ? "bg-yellow-400 text-black"
                  : "bg-red-950 hover:bg-black"}"
                title=${isBlocked
                  ? translateText("phone.unblock")
                  : translateText("phone.block")}
                @click=${() => this.toggleBlock(id)}
              >
                ${isBlocked ? "🔇" : "🚫"}
              </button>
            </div>
          `;
        })}
      </div>
    `;
  }

  // Blocks only live for this match; the server is the source of truth, this
  // set merely mirrors it for display.
  private toggleBlock(id: string): void {
    if (this.blocked.has(id)) {
      this.blocked.delete(id);
      this.controller!.unblock(id);
    } else {
      this.blocked.add(id);
      this.controller!.block(id);
    }
    this.tick++;
  }

  private renderInCall() {
    const peers = this.controller!.machine.peers;
    return html`
      <div class="mb-2">
        <div class="text-xs opacity-80 mb-1">
          ${translateText("phone.in_call")}
        </div>
        ${peers.map(
          (id) =>
            html`<div class="px-2 py-1 rounded bg-red-950 mb-1">
              ${this.nameOf(id)}
            </div>`,
        )}
        <button
          class="w-full mt-1 px-2 py-1 rounded bg-red-950 hover:bg-black text-xs"
          @click=${() => this.controller!.toggleMute()}
        >
          ${this.controller!.muted
            ? translateText("phone.unmute")
            : translateText("phone.mute")}
        </button>
      </div>
      <div class="text-xs opacity-80 mb-1">${translateText("phone.call")}</div>
      ${this.renderDirectory()}
    `;
  }

  private renderMissed() {
    const missed = this.controller!.machine.missed;
    if (missed.length === 0) return html``;
    return html`
      <div class="mt-2 pt-2 border-t border-red-950">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs opacity-80"
            >${translateText("phone.missed_calls")}</span
          >
          <button
            class="text-xs px-2 py-0.5 rounded bg-red-950 hover:bg-black"
            @click=${() => this.controller!.machine.clearMissed()}
          >
            ✕
          </button>
        </div>
        ${missed.map(
          (mc) => html`<div class="text-xs opacity-90">${mc.username}</div>`,
        )}
      </div>
    `;
  }

  // A dedicated slider: the ring must be tunable down without dragging the
  // rest of the game's sound along with it.
  private renderVolume() {
    return html`
      <div class="mt-2 pt-2 border-t border-red-950 flex items-center gap-2">
        <span class="text-xs opacity-80">${translateText("phone.volume")}</span>
        <input
          class="flex-1"
          type="range"
          min="0"
          max="1"
          step="0.05"
          .value=${String(this.controller!.volume)}
          @input=${(e: Event) => {
            this.controller!.setVolume(
              Number((e.target as HTMLInputElement).value),
            );
            this.tick++;
          }}
        />
      </div>
      <label class="mt-2 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          .checked=${this.controller!.alliesOnly}
          @change=${(e: Event) => {
            this.controller!.setAlliesOnly(
              (e.target as HTMLInputElement).checked,
            );
            this.tick++;
          }}
        />
        ${translateText("phone.allies_only")}
      </label>
    `;
  }

  private nameOf(clientID: string): string {
    const p = this.callables().find((x) => x.clientID() === clientID);
    return p?.displayName() ?? clientID;
  }
}
