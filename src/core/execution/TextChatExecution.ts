import { TEXT_CHAT_MAX_LENGTH, TextChatChannel } from "../Schemas";
import { Execution, Game, Player, PlayerID } from "../game/Game";

/**
 * Delivers a free-text chat message.
 *
 * Unlike QuickChatExecution — which carries a key into a fixed phrase table —
 * this carries player-authored text, so it re-checks everything the wire schema
 * already checked. The schema guards the network boundary; this guards the
 * simulation, which also runs replays and singleplayer where no schema ran.
 *
 * Recipients are resolved here rather than on the client so that a modified
 * client cannot address a message to players who should not see it. One update
 * is emitted per recipient, so text a player was not meant to read never
 * reaches their machine at all.
 */
export class TextChatExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(
    private sender: Player,
    private channel: TextChatChannel,
    private text: string,
    private recipientID: PlayerID | undefined,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    this.active = false;

    // A dead player has no voice. Checked here rather than at send time because
    // an intent is created a tick before it executes.
    if (!this.sender.isAlive()) return;

    if (!this.sender.canSendTextChat()) return;

    const text = this.text.trim();
    if (text.length === 0 || text.length > TEXT_CHAT_MAX_LENGTH) return;

    const recipients = this.resolveRecipients();
    if (recipients.length === 0) return;

    this.sender.recordTextChat();

    for (const recipient of recipients) {
      this.mg.displayTextChat(text, this.channel, this.sender, recipient);
    }
  }

  /**
   * Who receives this message. The sender is always included so their own
   * message appears in their log — the client renders from these updates only,
   * and echoing locally instead would show text that was never delivered.
   */
  private resolveRecipients(): Player[] {
    switch (this.channel) {
      case "all":
        return this.mg.players().filter((p) => p.isAlive());

      case "team": {
        // isFriendly covers both team membership and active alliances, so this
        // follows the alliance graph as it stands this tick — breaking an
        // alliance immediately stops delivery.
        return this.mg
          .players()
          .filter(
            (p) =>
              p.isAlive() && (p === this.sender || this.sender.isFriendly(p)),
          );
      }

      case "player": {
        if (this.recipientID === undefined) return [];
        if (!this.mg.hasPlayer(this.recipientID)) return [];
        const recipient = this.mg.player(this.recipientID);
        if (!recipient.isAlive()) return [];
        // Whispering to yourself is a no-op, not a duplicated message.
        if (recipient === this.sender) return [];
        return [this.sender, recipient];
      }
    }
  }

  owner(): Player {
    return this.sender;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    // Players sit in the spawn phase for a while; staying silent there would
    // make team coordination impossible exactly when it is most useful.
    return true;
  }
}
