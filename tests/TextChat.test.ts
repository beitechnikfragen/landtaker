import { TextChatExecution } from "../src/core/execution/TextChatExecution";
import { Game, Player, PlayerType } from "../src/core/game/Game";
import {
  DisplayTextChatUpdate,
  GameUpdateType,
} from "../src/core/game/GameUpdates";
import {
  TEXT_CHAT_MAX_LENGTH,
  TextChatChannel,
  TextChatIntentSchema,
} from "../src/core/Schemas";
import { playerInfo, setup } from "./util/Setup";

let game: Game;
let player1: Player;
let player2: Player;
let player3: Player;

/**
 * Runs a chat execution to completion and returns the delivery updates it
 * produced. Mirrors QuickChat.test.ts: addExecution queues into unInitExecs, so
 * the first tick runs init() and the second runs tick().
 */
function sendTextChat(
  sender: Player,
  channel: TextChatChannel,
  text: string,
  recipient?: Player,
): DisplayTextChatUpdate[] {
  game.addExecution(
    new TextChatExecution(sender, channel, text, recipient?.id()),
  );
  game.executeNextTick(); // init
  const updates = game.executeNextTick(); // tick
  return (updates[GameUpdateType.DisplayTextChatEvent] ??
    []) as DisplayTextChatUpdate[];
}

/** The smallIDs a message was actually delivered to. */
function recipientsOf(updates: DisplayTextChatUpdate[]): number[] {
  return updates.map((u) => u.recipientID).sort((a, b) => a - b);
}

describe("TextChat delivery", () => {
  beforeEach(async () => {
    game = await setup("plains", {}, [
      playerInfo("player1", PlayerType.Human),
      playerInfo("player2", PlayerType.Human),
      playerInfo("player3", PlayerType.Human),
    ]);

    player1 = game.player("player1");
    player1.conquer(game.ref(0, 0));

    player2 = game.player("player2");
    player2.conquer(game.ref(0, 1));

    player3 = game.player("player3");
    player3.conquer(game.ref(0, 2));

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
  });

  test("all-chat reaches every living player, including the sender", () => {
    const updates = sendTextChat(player1, "all", "hello everyone");

    expect(recipientsOf(updates)).toEqual(
      [player1, player2, player3].map((p) => p.smallID()).sort((a, b) => a - b),
    );
    expect(updates[0].text).toBe("hello everyone");
    expect(updates[0].senderID).toBe(player1.smallID());
  });

  test("whisper reaches only the sender and the named recipient", () => {
    const updates = sendTextChat(player1, "player", "just for you", player2);

    expect(recipientsOf(updates)).toEqual(
      [player1.smallID(), player2.smallID()].sort((a, b) => a - b),
    );
    // The uninvolved player must not receive it at all — not merely have it
    // hidden client-side.
    expect(recipientsOf(updates)).not.toContain(player3.smallID());
  });

  test("a whisper names the other party on both copies", () => {
    // Each side needs to know who the conversation is with so a client can file
    // the message under the right thread. The sender's own copy cannot derive
    // it — senderID is themselves.
    const updates = sendTextChat(player1, "player", "just for you", player2);

    const senderCopy = updates.find(
      (u) => u.recipientID === player1.smallID(),
    )!;
    const receiverCopy = updates.find(
      (u) => u.recipientID === player2.smallID(),
    )!;

    expect(senderCopy.whisperWithID).toBe(player2.smallID());
    expect(receiverCopy.whisperWithID).toBe(player1.smallID());
    expect(senderCopy.whisperWithName).toBe(player2.displayName());
    expect(receiverCopy.whisperWithName).toBe(player1.displayName());
  });

  test("all and team chat carry no whisper counterpart", () => {
    for (const channel of ["all", "team"] as const) {
      const updates = sendTextChat(player1, channel, `hi ${channel}`);
      expect(updates.every((u) => u.whisperWithID === undefined)).toBe(true);
      // Cooldown would drop the second send, so advance past it.
      const cooldown = game.config().textChatCooldown();
      for (let i = 0; i < cooldown; i++) game.executeNextTick();
    }
  });

  test("whisper to a player who does not exist delivers nothing", () => {
    game.addExecution(
      new TextChatExecution(player1, "player", "hello", "nonexistent"),
    );
    game.executeNextTick();
    const updates = game.executeNextTick();

    expect(updates[GameUpdateType.DisplayTextChatEvent] ?? []).toHaveLength(0);
  });

  test("whispering to yourself delivers nothing", () => {
    const updates = sendTextChat(player1, "player", "note to self", player1);
    expect(updates).toHaveLength(0);
  });

  test("team chat reaches only allies", () => {
    // player1 and player2 ally; player3 stays outside.
    player1.createAllianceRequest(player2)?.accept();
    expect(player1.isAlliedWith(player2)).toBe(true);

    const updates = sendTextChat(player1, "team", "regroup north");

    expect(recipientsOf(updates)).toEqual(
      [player1.smallID(), player2.smallID()].sort((a, b) => a - b),
    );
    expect(recipientsOf(updates)).not.toContain(player3.smallID());
  });

  test("team chat with no allies reaches only the sender", () => {
    const updates = sendTextChat(player1, "team", "anyone there?");
    expect(recipientsOf(updates)).toEqual([player1.smallID()]);
  });

  test("a dead player cannot send", () => {
    // Strip the sender of all territory, which kills them.
    for (const tile of player1.tiles()) {
      player1.relinquish(tile);
    }
    expect(player1.isAlive()).toBe(false);

    const updates = sendTextChat(player1, "all", "still here");
    expect(updates).toHaveLength(0);
  });

  test("dead players do not receive all-chat", () => {
    for (const tile of player3.tiles()) {
      player3.relinquish(tile);
    }
    expect(player3.isAlive()).toBe(false);

    const updates = sendTextChat(player1, "all", "who is left");
    expect(recipientsOf(updates)).not.toContain(player3.smallID());
  });
});

describe("TextChat rate limiting", () => {
  beforeEach(async () => {
    game = await setup("plains", {}, [
      playerInfo("player1", PlayerType.Human),
      playerInfo("player2", PlayerType.Human),
      playerInfo("player3", PlayerType.Human),
    ]);
    player1 = game.player("player1");
    player1.conquer(game.ref(0, 0));
    player2 = game.player("player2");
    player2.conquer(game.ref(0, 1));
    player3 = game.player("player3");
    player3.conquer(game.ref(0, 2));
    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
  });

  test("a second message inside the cooldown is dropped", () => {
    expect(sendTextChat(player1, "all", "first")).not.toHaveLength(0);
    expect(sendTextChat(player1, "all", "second")).toHaveLength(0);
  });

  test("sending is allowed again once the cooldown expires", () => {
    sendTextChat(player1, "all", "first");

    const cooldown = game.config().textChatCooldown();
    for (let i = 0; i < cooldown; i++) {
      game.executeNextTick();
    }

    expect(sendTextChat(player1, "all", "second")).not.toHaveLength(0);
  });

  test("the cooldown is per sender, not global", () => {
    sendTextChat(player1, "all", "first");
    // player2 is unaffected by player1's cooldown.
    expect(sendTextChat(player2, "all", "mine too")).not.toHaveLength(0);
  });

  test("switching channel or recipient does not bypass the cooldown", () => {
    expect(sendTextChat(player1, "all", "first")).not.toHaveLength(0);
    // A spammer cycling channels and targets must still be blocked.
    expect(sendTextChat(player1, "team", "second")).toHaveLength(0);
    expect(sendTextChat(player1, "player", "third", player2)).toHaveLength(0);
    expect(sendTextChat(player1, "player", "fourth", player3)).toHaveLength(0);
  });

  test("a dropped message does not consume the cooldown", () => {
    // An empty message never sends, so it must not lock out a real one.
    expect(sendTextChat(player1, "all", "   ")).toHaveLength(0);
    expect(sendTextChat(player1, "all", "a real message")).not.toHaveLength(0);
  });
});

describe("TextChat message validation", () => {
  beforeEach(async () => {
    game = await setup("plains", {}, [
      playerInfo("player1", PlayerType.Human),
      playerInfo("player2", PlayerType.Human),
    ]);
    player1 = game.player("player1");
    player1.conquer(game.ref(0, 0));
    player2 = game.player("player2");
    player2.conquer(game.ref(0, 1));
    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
  });

  test("whitespace-only messages are dropped", () => {
    expect(sendTextChat(player1, "all", "     ")).toHaveLength(0);
  });

  test("messages are trimmed before delivery", () => {
    const updates = sendTextChat(player1, "all", "  padded  ");
    expect(updates[0].text).toBe("padded");
  });

  test("an over-length message is dropped by the execution", () => {
    // The schema rejects this at the wire, but singleplayer and replays reach
    // the execution without a schema pass, so it must refuse it too.
    const tooLong = "x".repeat(TEXT_CHAT_MAX_LENGTH + 1);
    expect(sendTextChat(player1, "all", tooLong)).toHaveLength(0);
  });

  test("a message at exactly the limit is delivered", () => {
    const atLimit = "x".repeat(TEXT_CHAT_MAX_LENGTH);
    const updates = sendTextChat(player1, "all", atLimit);
    expect(updates).not.toHaveLength(0);
    expect(updates[0].text).toBe(atLimit);
  });
});

describe("TextChatIntentSchema", () => {
  const valid = { type: "text_chat" as const, channel: "all" as const };

  test("accepts a normal message", () => {
    const result = TextChatIntentSchema.safeParse({
      ...valid,
      text: "good luck",
    });
    expect(result.success).toBe(true);
  });

  test("rejects text over the cap", () => {
    const result = TextChatIntentSchema.safeParse({
      ...valid,
      text: "x".repeat(TEXT_CHAT_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  test("rejects an empty message", () => {
    expect(TextChatIntentSchema.safeParse({ ...valid, text: "" }).success).toBe(
      false,
    );
    expect(
      TextChatIntentSchema.safeParse({ ...valid, text: "   " }).success,
    ).toBe(false);
  });

  test("rejects newlines, which would forge extra chat lines", () => {
    expect(
      TextChatIntentSchema.safeParse({ ...valid, text: "hello\nworld" })
        .success,
    ).toBe(false);
    expect(
      TextChatIntentSchema.safeParse({ ...valid, text: "hello\r\nworld" })
        .success,
    ).toBe(false);
  });

  test("rejects bidi overrides, which would scramble surrounding UI text", () => {
    expect(
      TextChatIntentSchema.safeParse({ ...valid, text: "hello\u202Eworld" })
        .success,
    ).toBe(false);
    expect(
      TextChatIntentSchema.safeParse({ ...valid, text: "hello\u2066world" })
        .success,
    ).toBe(false);
  });

  test("rejects an unknown channel", () => {
    expect(
      TextChatIntentSchema.safeParse({
        type: "text_chat",
        channel: "everyone",
        text: "hi",
      }).success,
    ).toBe(false);
  });

  test("accepts emoji and non-latin text", () => {
    expect(
      TextChatIntentSchema.safeParse({ ...valid, text: "gg 🎉 привет 你好" })
        .success,
    ).toBe(true);
  });
});
