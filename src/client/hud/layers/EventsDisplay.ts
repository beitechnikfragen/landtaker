import { html, LitElement } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { DirectiveResult } from "lit/directive.js";
import { unsafeHTML, UnsafeHTMLDirective } from "lit/directives/unsafe-html.js";
import { EventBus } from "../../../core/EventBus";
import {
  AllPlayers,
  MESSAGE_TYPE_CATEGORIES,
  MessageCategory,
  MessageType,
} from "../../../core/game/Game";
import {
  AllianceExpiredUpdate,
  AllianceRequestReplyUpdate,
  BrokeAllianceUpdate,
  DisplayChatMessageUpdate,
  DisplayMessageUpdate,
  DonateEventUpdate,
  EmojiUpdate,
  GameUpdateType,
  TargetPlayerUpdate,
  UnitIncomingUpdate,
} from "../../../core/game/GameUpdates";
import { UserSettings } from "../../../core/game/UserSettings";
import { Controller } from "../../Controller";
import { SendAllianceRequestIntentEvent } from "../../Transport";

import { onlyImages } from "../../../core/Util";
import { GoToPlayerEvent, GoToUnitEvent } from "../../TransformHandler";
import { GameView, PlayerView, UnitView } from "../../view";

import { PlaySoundEffectEvent } from "../../sound/Sounds";
import { UIState } from "../../UIState";
import { renderNumber, renderTroops, translateText } from "../../Utils";

interface GameEvent {
  description: string;
  unsafeDescription?: boolean;
  type: MessageType;
  highlight?: boolean;
  createdAt: number;
  onDelete?: () => void;
  focusID?: number;
  unitView?: UnitView;
}

/** Incoming ordnance and landings: pinned above the feed, red inset. */
const HOT_TYPES: ReadonlySet<MessageType> = new Set([
  MessageType.NUKE_INBOUND,
  MessageType.HYDROGEN_BOMB_INBOUND,
  MessageType.MIRV_INBOUND,
  MessageType.NAVAL_INVASION_INBOUND,
]);

const isHot = (type: MessageType): boolean => HOT_TYPES.has(type);

/** Feed text colour per category — muted versions of the semantic palette. */
const CATEGORY_COLORS: Record<MessageCategory, string> = {
  [MessageCategory.ATTACK]: "#e8a37c",
  [MessageCategory.NUKE]: "#e07a8a",
  [MessageCategory.ALLIANCE]: "#9ccf8f",
  [MessageCategory.TRADE]: "var(--color-lt-gold)",
  [MessageCategory.CHAT]: "#8fb8d9",
};

const FILTER_CHIPS: { category: MessageCategory | null; key: string }[] = [
  { category: null, key: "events_display.filter_all" },
  { category: MessageCategory.ATTACK, key: "events_display.filter_war" },
  { category: MessageCategory.NUKE, key: "events_display.filter_nuke" },
  { category: MessageCategory.ALLIANCE, key: "events_display.filter_pact" },
  { category: MessageCategory.TRADE, key: "events_display.filter_trade" },
  { category: MessageCategory.CHAT, key: "events_display.filter_chat" },
];

/** One stroke path per category, drawn at 24×24. */
const CATEGORY_ICON_PATHS: Record<MessageCategory, string> = {
  [MessageCategory.ATTACK]: "M15 4l5 5-9 9-5-5zM3 21l6-6",
  [MessageCategory.NUKE]:
    "M12 2c2.5 3 4 6.5 4 10a4 4 0 0 1-8 0c0-3.5 1.5-7 4-10zM9 20h6",
  [MessageCategory.ALLIANCE]:
    "M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  [MessageCategory.TRADE]:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.6h-3a1.8 1.8 0 0 0 0 3.6h4",
  [MessageCategory.CHAT]:
    "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2z",
};

@customElement("events-display")
export class EventsDisplay extends LitElement implements Controller {
  public eventBus: EventBus;
  public game: GameView;
  public uiState: UIState;

  private active: boolean = false;
  private events: GameEvent[] = [];
  private userSettings = new UserSettings();

  @state() private _isVisible: boolean = false;

  /** null shows everything; a category narrows the scrolling feed. */
  @state() private _activeFilter: MessageCategory | null = null;

  @query(".events-container")
  private _eventsContainer?: HTMLDivElement;
  private _shouldScrollToBottom = true;

  @query(".important-events-container")
  private _importantEventsContainer?: HTMLDivElement;
  private _shouldScrollImportantToBottom = true;

  updated(changed: Map<string, unknown>) {
    super.updated(changed);
    if (this._eventsContainer && this._shouldScrollToBottom) {
      this._eventsContainer.scrollTop = this._eventsContainer.scrollHeight;
    }
    if (this._importantEventsContainer && this._shouldScrollImportantToBottom) {
      this._importantEventsContainer.scrollTop =
        this._importantEventsContainer.scrollHeight;
    }
  }

  private updateMap = [
    [GameUpdateType.DisplayEvent, this.onDisplayMessageEvent.bind(this)],
    [GameUpdateType.DisplayChatEvent, this.onDisplayChatEvent.bind(this)],
    [
      GameUpdateType.AllianceRequestReply,
      this.onAllianceRequestReplyEvent.bind(this),
    ],
    [GameUpdateType.BrokeAlliance, this.onBrokeAllianceEvent.bind(this)],
    [GameUpdateType.TargetPlayer, this.onTargetPlayerEvent.bind(this)],
    [GameUpdateType.Emoji, this.onEmojiMessageEvent.bind(this)],
    [GameUpdateType.UnitIncoming, this.onUnitIncomingEvent.bind(this)],
    [GameUpdateType.AllianceExpired, this.onAllianceExpiredEvent.bind(this)],
    [GameUpdateType.DonateEvent, this.onDonateEvent.bind(this)],
  ] as const;

  constructor() {
    super();
    this.events = [];
  }

  init() {
    this.eventBus.on(
      SendAllianceRequestIntentEvent,
      this.onAllianceRequestSentConfirmation.bind(this),
    );
  }

  private onAllianceRequestSentConfirmation(e: SendAllianceRequestIntentEvent) {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer || e.requestor.id() !== myPlayer.id()) {
      return;
    }
    // If the recipient already has a pending alliance request to us, this
    // action accepts that request instead of sending a new one, so don't
    // show the "alliance request sent" confirmation.
    if (e.recipient.isRequestingAllianceWith(e.requestor)) {
      return;
    }
    this.addEvent({
      description: translateText("events_display.alliance_request_sent", {
        name: e.recipient.name(),
      }),
      type: MessageType.ALLIANCE_REQUEST,
      createdAt: this.game.ticks(),
    });
  }

  tick() {
    this.active = true;

    if (this._eventsContainer) {
      const el = this._eventsContainer;
      this._shouldScrollToBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 5;
    } else {
      this._shouldScrollToBottom = true;
    }

    if (this._importantEventsContainer) {
      const el = this._importantEventsContainer;
      this._shouldScrollImportantToBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 5;
    } else {
      this._shouldScrollImportantToBottom = true;
    }

    if (!this._isVisible && !this.game.inSpawnPhase()) {
      this._isVisible = true;
      this.requestUpdate();
    }

    const myPlayer = this.game.myPlayer();
    if (!myPlayer || !myPlayer.isAlive()) {
      if (this._isVisible) {
        this._isVisible = false;
        this.requestUpdate();
      }
      return;
    }

    const updates = this.game.updatesSinceLastTick();
    if (updates) {
      for (const [ut, fn] of this.updateMap) {
        updates[ut]?.forEach(fn as (event: unknown) => void);
      }
    }

    let remainingEvents = this.events.filter((event) => {
      const isInboundWarning = isHot(event.type);
      // Inbound warnings live exactly as long as the threat does; everything
      // else ages out of the feed after 30s so the timestamps stay meaningful.
      const expired =
        !isInboundWarning && this.game.ticks() - event.createdAt >= 300;
      const unitGone =
        isInboundWarning &&
        event.unitView !== undefined &&
        !event.unitView.isActive();
      const shouldKeep = !expired && !unitGone;
      if (!shouldKeep && event.onDelete) {
        event.onDelete();
      }
      return shouldKeep;
    });

    if (remainingEvents.length > 30) {
      remainingEvents = remainingEvents.slice(-30);
    }

    if (this.events.length !== remainingEvents.length) {
      this.events = remainingEvents;
      this.requestUpdate();
    }

    this.requestUpdate();
  }

  private addEvent(event: GameEvent) {
    this.events = [...this.events, event];
    this.requestUpdate();
  }

  onDisplayMessageEvent(event: DisplayMessageUpdate) {
    const myPlayer = this.game.myPlayer();
    if (
      event.playerID !== null &&
      (!myPlayer || myPlayer.smallID() !== event.playerID)
    ) {
      return;
    }

    // Captured trade-ship gold is surfaced as a transient +gold pip in
    // control-panel rather than as a scroll-list entry.
    if (event.message === "events_display.received_gold_from_captured_ship") {
      return;
    }

    let description: string = event.message;
    if (event.message.startsWith("events_display.")) {
      description = translateText(event.message, event.params ?? {});
    }

    const unitView =
      event.unitID !== undefined ? this.game.unit(event.unitID) : undefined;
    this.addEvent({
      description: description,
      createdAt: this.game.ticks(),
      highlight: true,
      type: event.messageType,
      unsafeDescription: true,
      unitView: unitView,
      focusID: event.focusPlayerID,
    });
  }

  onDisplayChatEvent(event: DisplayChatMessageUpdate) {
    const myPlayer = this.game.myPlayer();
    if (
      event.playerID === null ||
      !myPlayer ||
      myPlayer.smallID() !== event.playerID
    ) {
      return;
    }

    const baseMessage = translateText(`chat.${event.category}.${event.key}`);
    let translatedMessage = baseMessage;
    if (event.target) {
      try {
        const targetPlayer = this.game.player(event.target);
        const targetName = targetPlayer?.displayName() ?? event.target;
        translatedMessage = baseMessage.replace("[P1]", targetName);
      } catch (e) {
        console.warn(
          `Failed to resolve player for target ID '${event.target}'`,
          e,
        );
        return;
      }
    }

    let otherPlayerDiplayName: string = "";
    if (event.recipient !== null) {
      //'recipient' parameter contains sender ID or recipient ID
      const player = this.game.player(event.recipient);
      otherPlayerDiplayName = player ? player.displayName() : "";
    }

    this.addEvent({
      description: translateText(event.isFrom ? "chat.from" : "chat.to", {
        user: otherPlayerDiplayName,
        msg: translatedMessage,
      }),
      createdAt: this.game.ticks(),
      highlight: true,
      type: MessageType.CHAT,
      unsafeDescription: false,
    });
    this.eventBus.emit(new PlaySoundEffectEvent("message"));
  }

  onAllianceRequestReplyEvent(update: AllianceRequestReplyUpdate) {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer || update.request.requestorID !== myPlayer.smallID()) {
      return;
    }

    const recipient = this.game.playerBySmallID(
      update.request.recipientID,
    ) as PlayerView;
    this.addEvent({
      description: translateText("events_display.alliance_request_status", {
        name: recipient.displayName(),
        status: update.accepted
          ? translateText("events_display.alliance_accepted")
          : translateText("events_display.alliance_rejected"),
      }),
      type: update.accepted
        ? MessageType.ALLIANCE_ACCEPTED
        : MessageType.ALLIANCE_REJECTED,
      highlight: true,
      createdAt: this.game.ticks(),
      focusID: update.request.recipientID,
    });
  }

  onBrokeAllianceEvent(update: BrokeAllianceUpdate) {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    const betrayed = this.game.playerBySmallID(update.betrayedID) as PlayerView;
    const traitor = this.game.playerBySmallID(update.traitorID) as PlayerView;

    if (betrayed.isDisconnected()) return; // Do not send the message if betraying a disconnected player

    if (!betrayed.isTraitor() && traitor === myPlayer) {
      this.eventBus.emit(new PlaySoundEffectEvent("alliance-broken"));
      const malusPercent = Math.round(
        (1 - this.game.config().traitorDefenseDebuff()) * 100,
      );

      const traitorDuration = Math.floor(
        this.game.config().traitorDuration() * 0.1,
      );
      const durationText =
        traitorDuration === 1
          ? translateText("events_display.duration_second")
          : translateText("events_display.duration_seconds_plural", {
              seconds: traitorDuration,
            });

      this.addEvent({
        description: translateText("events_display.betrayal_description", {
          name: betrayed.displayName(),
          malusPercent: malusPercent,
          durationText: durationText,
        }),
        type: MessageType.ALLIANCE_BROKEN,
        highlight: true,
        createdAt: this.game.ticks(),
        focusID: update.betrayedID,
      });
    } else if (betrayed === myPlayer) {
      this.eventBus.emit(new PlaySoundEffectEvent("alliance-broken"));
      this.addEvent({
        description: translateText("events_display.betrayed_you", {
          name: traitor.displayName(),
        }),
        type: MessageType.ALLIANCE_BROKEN,
        highlight: true,
        createdAt: this.game.ticks(),
        focusID: update.traitorID,
      });
    }
  }

  onAllianceExpiredEvent(update: AllianceExpiredUpdate) {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    const otherID =
      update.player1ID === myPlayer.smallID()
        ? update.player2ID
        : update.player2ID === myPlayer.smallID()
          ? update.player1ID
          : null;
    if (otherID === null) return;
    const other = this.game.playerBySmallID(otherID) as PlayerView;
    if (!other || !myPlayer.isAlive() || !other.isAlive()) return;

    this.addEvent({
      description: translateText("events_display.alliance_expired", {
        name: other.displayName(),
      }),
      type: MessageType.ALLIANCE_EXPIRED,
      highlight: true,
      createdAt: this.game.ticks(),
      focusID: otherID,
    });
  }

  onDonateEvent(update: DonateEventUpdate) {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    const isRecipient = update.recipientId === myPlayer.id();
    const isSender = update.senderId === myPlayer.id();
    if (!isRecipient && !isSender) return;

    const other = isRecipient
      ? (this.game.player(update.senderId) as PlayerView)
      : (this.game.player(update.recipientId) as PlayerView);

    const isGold = update.donationType === "gold";
    const messageKey = isRecipient
      ? isGold
        ? "events_display.received_gold_from_player"
        : "events_display.received_troops_from_player"
      : isGold
        ? "events_display.sent_gold_to_player"
        : "events_display.sent_troops_to_player";
    const params: Record<string, string | number> = {
      name: other.displayName(),
      [isGold ? "gold" : "troops"]: isGold
        ? renderNumber(update.amount)
        : renderTroops(Number(update.amount)),
    };

    this.addEvent({
      description: translateText(messageKey, params),
      type: isRecipient
        ? MessageType.DONATION_RECEIVED
        : MessageType.DONATION_SENT,
      highlight: true,
      createdAt: this.game.ticks(),
      focusID: other.smallID(),
    });
  }

  onTargetPlayerEvent(event: TargetPlayerUpdate) {
    const other = this.game.playerBySmallID(event.playerID) as PlayerView;
    const myPlayer = this.game.myPlayer() as PlayerView;
    if (!myPlayer || !myPlayer.isFriendly(other)) return;

    const target = this.game.playerBySmallID(event.targetID) as PlayerView;

    this.addEvent({
      description: translateText("events_display.attack_request", {
        name: other.displayName(),
        target: target.displayName(),
      }),
      type: MessageType.ATTACK_REQUEST,
      highlight: true,
      createdAt: this.game.ticks(),
      focusID: event.targetID,
    });
  }

  emitGoToPlayerEvent(attackerID: number) {
    const attacker = this.game.playerBySmallID(attackerID) as PlayerView;
    if (!attacker) return;
    this.eventBus.emit(new GoToPlayerEvent(attacker));
  }

  emitGoToUnitEvent(unit: UnitView) {
    this.eventBus.emit(new GoToUnitEvent(unit));
  }

  onEmojiMessageEvent(update: EmojiUpdate) {
    // Honor the "Disable emojis" setting: don't surface received emojis in the
    // events feed either (#4430).
    if (!this.userSettings.emojis()) return;
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    const recipient =
      update.emoji.recipientID === AllPlayers
        ? AllPlayers
        : this.game.playerBySmallID(update.emoji.recipientID);
    const sender = this.game.playerBySmallID(
      update.emoji.senderID,
    ) as PlayerView;

    if (recipient === myPlayer) {
      this.addEvent({
        description: `${sender.displayName()}: ${update.emoji.message}`,
        unsafeDescription: true,
        type: MessageType.CHAT,
        highlight: true,
        createdAt: this.game.ticks(),
        focusID: update.emoji.senderID,
      });
    } else if (sender === myPlayer && recipient !== AllPlayers) {
      this.addEvent({
        description: translateText("events_display.sent_emoji", {
          name: (recipient as PlayerView).displayName(),
          emoji: update.emoji.message,
        }),
        unsafeDescription: true,
        type: MessageType.CHAT,
        highlight: true,
        createdAt: this.game.ticks(),
        focusID: recipient.smallID(),
      });
    }
  }

  onUnitIncomingEvent(event: UnitIncomingUpdate) {
    const myPlayer = this.game.myPlayer();

    if (!myPlayer || myPlayer.smallID() !== event.playerID) {
      return;
    }

    const unitView = this.game.unit(event.unitID);

    this.addEvent({
      description: event.message,
      type: event.messageType,
      unsafeDescription: false,
      highlight: true,
      createdAt: this.game.ticks(),
      unitView: unitView,
    });
  }

  private getEventDescription(
    event: GameEvent,
  ): string | DirectiveResult<typeof UnsafeHTMLDirective> {
    return event.unsafeDescription
      ? unsafeHTML(onlyImages(event.description))
      : event.description;
  }

  /** Elapsed time since the event, mock-style: "now", then m:ss. */
  private formatAge(createdAt: number): string {
    const seconds = Math.max(
      0,
      Math.floor((this.game.ticks() - createdAt) / 10),
    );
    if (seconds < 2) return translateText("events_display.now");
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  private categoryIcon(category: MessageCategory, extraClass = "") {
    return html`<svg
      viewBox="0 0 24 24"
      class="w-3.5 h-3.5 shrink-0 mt-0.5 ${extraClass}"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d=${CATEGORY_ICON_PATHS[category]} />
    </svg>`;
  }

  private onRowClick(event: GameEvent) {
    if (event.focusID) {
      this.emitGoToPlayerEvent(event.focusID);
    } else if (event.unitView) {
      this.emitGoToUnitEvent(event.unitView);
    }
  }

  /** Pinned threat row: red inset bar, red icon, age on the right. */
  private renderHotRow(event: GameEvent) {
    return html`
      <div
        class="flex gap-2 items-start px-2.5 py-2 text-[13px] leading-snug text-lt-100 bg-lt-bad/10 [box-shadow:inset_3px_0_0_var(--color-lt-bad)] border-b border-lt-700/60 last:border-b-0 ${event.unitView ||
        event.focusID
          ? "cursor-pointer hover:bg-lt-bad/20"
          : ""}"
        @click=${() => this.onRowClick(event)}
      >
        <span class="text-lt-bad">
          ${this.categoryIcon(MESSAGE_TYPE_CATEGORIES[event.type])}
        </span>
        <div class="flex-1 min-w-0 font-medium">
          ${this.getEventDescription(event)}
        </div>
        <span
          class="shrink-0 text-[13px] font-bold tabular-nums text-lt-bad"
          translate="no"
          >${this.formatAge(event.createdAt)}</span
        >
      </div>
    `;
  }

  private renderBetrayalRow() {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer || !myPlayer.isTraitor()) return html``;
    const remainingSeconds = Math.ceil(
      myPlayer.getTraitorRemainingTicks() / 10,
    );
    if (remainingSeconds <= 0) return html``;
    return html`
      <div
        class="flex gap-2 items-start px-2.5 py-2 text-[13px] leading-snug text-lt-gold bg-lt-gold/10 [box-shadow:inset_3px_0_0_var(--color-lt-gold)] border-b border-lt-700/60 last:border-b-0"
      >
        <div class="flex-1 min-w-0 font-medium">
          ${translateText("events_display.betrayal_debuff_ends", {
            time: remainingSeconds,
          })}
        </div>
      </div>
    `;
  }

  private renderEventRow(event: GameEvent) {
    const category = MESSAGE_TYPE_CATEGORIES[event.type];
    return html`
      <div
        class="flex gap-2 items-start px-2.5 py-1.5 text-[12.5px] leading-snug border-b border-lt-700/45 last:border-b-0 ${event.focusID ||
        event.unitView
          ? "cursor-pointer hover:bg-white/5"
          : ""}"
        style="color: ${CATEGORY_COLORS[category]}"
        @click=${() => this.onRowClick(event)}
      >
        ${this.categoryIcon(category)}
        <div class="flex-1 min-w-0">${this.getEventDescription(event)}</div>
        <span
          class="shrink-0 text-[11px] tabular-nums text-lt-500"
          translate="no"
          >${this.formatAge(event.createdAt)}</span
        >
      </div>
    `;
  }

  private renderFilterChips() {
    return FILTER_CHIPS.map(
      (chip) => html`
        <button
          class="lt-label !text-[10px] border px-1.5 py-px transition-colors ${this
            ._activeFilter === chip.category
            ? "!text-lt-accent border-lt-accent/50"
            : "border-lt-600 hover:!text-lt-100"}"
          @click=${() => {
            this._activeFilter = chip.category;
          }}
        >
          ${translateText(chip.key)}
        </button>
      `,
    );
  }

  render() {
    if (!this.active || !this._isVisible) {
      return html``;
    }

    const myPlayer = this.game.myPlayer();
    const showBetrayalTimer = !!(
      myPlayer &&
      myPlayer.isTraitor() &&
      myPlayer.getTraitorRemainingTicks() > 0
    );

    const hotEvents: GameEvent[] = [];
    const feedEvents: GameEvent[] = [];
    for (const event of this.events) {
      (isHot(event.type) ? hotEvents : feedEvents).push(event);
    }
    hotEvents.sort((a, b) => a.createdAt - b.createdAt);
    feedEvents.sort((a, b) => a.createdAt - b.createdAt);

    const visibleFeed =
      this._activeFilter === null
        ? feedEvents
        : feedEvents.filter(
            (e) => MESSAGE_TYPE_CATEGORIES[e.type] === this._activeFilter,
          );

    if (
      hotEvents.length === 0 &&
      feedEvents.length === 0 &&
      !showBetrayalTimer
    ) {
      return html``;
    }

    return html`
      <div
        class="w-full min-[1200px]:w-[340px] bg-[rgb(11_14_17/0.92)] border border-lt-700 backdrop-blur-sm pointer-events-auto"
      >
        <!-- header: title + category chips -->
        <div
          class="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-lt-700"
        >
          <span class="lt-label !text-[11px] mr-auto"
            >${translateText("events_display.title")}</span
          >
          ${this.renderFilterChips()}
        </div>
        <!-- pinned: inbound threats + betrayal debuff, never scroll away -->
        ${hotEvents.length > 0 || showBetrayalTimer
          ? html`
              <div class="border-b border-lt-700 important-events-container">
                ${hotEvents.map((event) => this.renderHotRow(event))}
                ${showBetrayalTimer ? this.renderBetrayalRow() : ""}
              </div>
            `
          : ""}
        <!-- the feed -->
        <div
          class="max-h-[18vh] lg:max-h-[28vh] overflow-y-auto events-container"
        >
          ${visibleFeed.map((event) => this.renderEventRow(event))}
        </div>
      </div>
    `;
  }

  createRenderRoot() {
    return this;
  }
}
