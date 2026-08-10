import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { assetUrl } from "../../../core/AssetUrls";
import type { PhoneMode } from "../../../core/Schemas";
import type { PhoneUiState } from "../../phone/CallStateMachine";
import type { PhoneController } from "../../phone/PhoneController";
import { translateText } from "../../Utils";
import type { GameView, PlayerView } from "../../view";

// The mini badge's phone glyph is a 19-frame sprite sheet (see
// resources/sprites/phone.png): frames are 128x128 source pixels each,
// packed left-to-right in a single row (2432x128 total) — 2x the 64px CSS
// badge, for HiDPI. Frame indices below are 0-based positions *within that
// sheet* — sheet index 0 is source frame "Sprite-0002.png", so sheet index =
// spriteNumber - 2. Confirmed by direct pixel inspection of the packed sheet:
//   sheet index 0-5   (Sprite 2-7)   idle, handset on the hook
//   sheet index 6-7   (Sprite 8-9)   ringing, motion lines by the handset
//   sheet index 8-12  (Sprite 10-14) handset lifted off the hook
//   sheet index 13-18 (Sprite 15-20) returning to rest; index 18 == index 0
//
// The badge renders at 64 CSS px (w-16/h-16 below). background-position, in
// pixel units, operates in *rendered* space — i.e. after background-size
// scaling — not in the source image's own pixel space. So both
// background-size and the per-frame step below are expressed in terms of the
// badge's rendered size, not the source frame's 128px: at badge size 64px,
// background-size is `64 * frameCount`px and each frame step is 64px, even
// though each source frame is 128px wide. Getting this wrong (e.g. stepping
// by the source frame size) would visibly skip every other frame.
const PHONE_BADGE_PX = 64;
const PHONE_SPRITE_TOTAL_FRAMES = 19;
const PHONE_SPRITE_URL = assetUrl("sprites/phone.png");

interface SpriteRange {
  // Inclusive start/end sheet indices (0-based).
  start: number;
  end: number;
}

// idle handset-on-hook frames, reused for "busy" (a refused call has nothing
// left to animate — it should just look like the phone is at rest again).
const IDLE_RANGE: SpriteRange = { start: 0, end: 5 };
const RINGING_RANGE: SpriteRange = { start: 6, end: 7 };
// The user was explicit that outgoing "dialing" (ringing at the far end)
// should use the same off-hook look as an active call: "für ich rufe an ist
// einfach der open state".
const OFF_HOOK_RANGE: SpriteRange = { start: 8, end: 12 };

const STYLE_ID = "phone-widget-sprite-styles";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // One steps() keyframe animation per state range, driven entirely by CSS
  // (background-position on the compositor-cheap background shorthand) so
  // there is no JS timer to manage or leak.
  //
  // steps(N) (default jump-end) divides the keyframe's travel distance into
  // N equal intervals and holds frame i for the whole of interval i, landing
  // on the *last* interval's end value only for a zero-duration instant. So
  // to give every one of F frames an equal, non-zero hold, the keyframe must
  // travel F full frame-widths (start frame through one frame *past* the
  // last frame), not F-1: "to" below is deliberately end+1, not end — using
  // "end" would make steps(F) divide F-1 frame-widths of travel into F
  // intervals, landing mid-frame on non-integer boundaries (visibly blurred
  // steps) and never actually holding the final frame.
  const css = (r: SpriteRange, name: string) => {
    const frames = r.end - r.start + 1;
    const startPx = -(r.start * PHONE_BADGE_PX);
    const endPx = -((r.end + 1) * PHONE_BADGE_PX);
    return `
      @keyframes ${name} {
        from { background-position-x: ${startPx}px; }
        to   { background-position-x: ${endPx}px; }
      }
      .phone-sprite-${name} {
        animation: ${name} ${frames * 120}ms steps(${frames}) infinite;
      }
    `;
  };
  style.textContent = `
    .phone-sprite {
      width: ${PHONE_BADGE_PX}px;
      height: ${PHONE_BADGE_PX}px;
      background-image: url("${PHONE_SPRITE_URL}");
      background-repeat: no-repeat;
      background-size: ${PHONE_SPRITE_TOTAL_FRAMES * PHONE_BADGE_PX}px ${PHONE_BADGE_PX}px;
      image-rendering: pixelated;
    }
    ${css(IDLE_RANGE, "phone-anim-idle")}
    ${css(RINGING_RANGE, "phone-anim-ringing")}
    ${css(OFF_HOOK_RANGE, "phone-anim-offhook")}
    @media (prefers-reduced-motion: reduce) {
      .phone-sprite-phone-anim-idle,
      .phone-sprite-phone-anim-ringing,
      .phone-sprite-phone-anim-offhook {
        animation: none;
        background-position-x: 0px;
      }
    }
  `;
  document.head.appendChild(style);
}

const ANIM_CLASS_BY_STATE: Record<PhoneUiState, string> = {
  idle: "phone-sprite-phone-anim-idle",
  ringing: "phone-sprite-phone-anim-ringing",
  dialing: "phone-sprite-phone-anim-offhook",
  "in-call": "phone-sprite-phone-anim-offhook",
  busy: "phone-sprite-phone-anim-idle",
};

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
    // controller/game are plain fields (not @state/@property), so assigning
    // them above does not schedule a re-render on its own. They hold large
    // object graphs (GameView is the whole game state) that we don't want
    // Lit deep-watching, so we nudge a single update here instead of making
    // the fields reactive.
    this.requestUpdate();
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
    // The sprite's own ringing frames already carry motion lines, which made
    // the old animate-bounce shake on the whole badge redundant (and the two
    // together looked like double motion) — kept only the sprite animation.
    return html`
      <div
        class="fixed bottom-24 right-4 z-50 cursor-pointer select-none"
        @click=${() => (this.expanded = true)}
        title=${translateText("phone.title")}
      >
        <div
          class="relative w-16 h-16 rounded-lg bg-red-700 border-2 border-red-900 shadow-lg flex items-center justify-center overflow-hidden"
        >
          <div
            class="phone-sprite ${ANIM_CLASS_BY_STATE[state]}"
            role="img"
            aria-label=${translateText("phone.title")}
          ></div>
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
      ${this.controller!.connectionFailed
        ? html`<div class="mb-2 text-xs text-yellow-300">
            ${translateText("phone.no_connection")}
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
