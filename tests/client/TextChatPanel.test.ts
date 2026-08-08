/**
 * @vitest-environment jsdom
 *
 * Panel-level tests for the in-game chat.
 *
 * The renderer refuses a software WebGL2 context on purpose, so a real match
 * cannot be driven headlessly. These drive the component directly against a
 * stub GameView instead, covering the parts the core tests cannot: that a
 * player only ever renders messages addressed to them, that conversations are
 * split into the right tabs, that the composer takes keys away from the game
 * while typing, and that the right intent is emitted.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SendTextChatEvent } from "../../src/client/Transport";
import { EventBus } from "../../src/core/EventBus";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import type { TextChatChannel } from "../../src/core/Schemas";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));

// Imported after the mock so the component picks up the stubbed translator.
const { TextChatPanel } =
  await import("../../src/client/hud/layers/TextChatPanel");

const ME = 1;
const OTHER = 2;
const THIRD = 3;

function makeUpdate(
  recipientID: number,
  text: string,
  channel: TextChatChannel = "all",
  senderID = OTHER,
  senderName = "Rival",
  whisperWith?: { id: number; name: string },
) {
  return {
    type: GameUpdateType.DisplayTextChatEvent,
    text,
    channel,
    senderID,
    senderName,
    recipientID,
    ...(whisperWith
      ? { whisperWithID: whisperWith.id, whisperWithName: whisperWith.name }
      : {}),
  };
}

/** A GameView stub exposing only what the panel touches. */
function makeGame(updates: unknown[]) {
  let consumed = false;
  return {
    myPlayer: () => ({ smallID: () => ME, id: () => "me" }),
    playerBySmallID: (id: number) => ({
      smallID: () => id,
      id: () => `player-${id}`,
      displayName: () => `Player${id}`,
    }),
    updatesSinceLastTick: () => {
      if (consumed) return null;
      consumed = true;
      return { [GameUpdateType.DisplayTextChatEvent]: updates };
    },
  };
}

async function mountPanel(updates: unknown[] = []) {
  const el = new TextChatPanel();
  el.eventBus = new EventBus();
  el.game = makeGame(updates) as never;
  document.body.appendChild(el);
  el.init();
  await el.updateComplete;
  return el;
}

/** Visible tab labels, in order. */
function tabLabels(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll("button"))
    .map((b) => b.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter((t) => t.length > 0);
}

async function openComposer(el: { updateComplete: Promise<unknown> }) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await el.updateComplete;
}

describe("TextChatPanel rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("renders a message addressed to this player", async () => {
    const el = await mountPanel([makeUpdate(ME, "hello there")]);
    el.tick();
    await el.updateComplete;

    expect(el.textContent).toContain("hello there");
    expect(el.textContent).toContain("Rival");
  });

  test("drops a message addressed to a different player", async () => {
    // Defence in depth: the sim already avoids sending these, but a bug there
    // must not turn into other players' private mail on screen.
    const el = await mountPanel([makeUpdate(OTHER, "not for you")]);
    el.tick();
    await el.updateComplete;

    expect(el.textContent).not.toContain("not for you");
  });

  test("escapes markup rather than rendering it", async () => {
    // Lit interpolation escapes by default; this pins that the panel never
    // switched to unsafeHTML the way the quick-chat display does.
    const el = await mountPanel([makeUpdate(ME, "<img src=x onerror=1>")]);
    el.tick();
    await el.updateComplete;

    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=1>");
  });

  test("renders nothing before the player exists", async () => {
    const el = new TextChatPanel();
    el.eventBus = new EventBus();
    el.game = { myPlayer: () => null } as never;
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.textContent?.trim()).toBe("");
  });
});

describe("TextChatPanel conversations", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("opens with an All and a Team tab", async () => {
    const el = await mountPanel();
    const labels = tabLabels(el);
    expect(labels.some((l) => l.includes("channel_all"))).toBe(true);
    expect(labels.some((l) => l.includes("channel_team"))).toBe(true);
  });

  test("a whisper opens its own tab named after the counterpart", async () => {
    const el = await mountPanel([
      makeUpdate(ME, "psst", "player", OTHER, "Rival", {
        id: OTHER,
        name: "Rival",
      }),
    ]);
    el.tick();
    await el.updateComplete;

    expect(tabLabels(el).some((l) => l.includes("Rival"))).toBe(true);
  });

  test("two whisper partners get separate tabs, not one merged log", async () => {
    // This is the whole point of the redesign: two people talking at once must
    // not interleave into an unreadable stream.
    const el = await mountPanel([
      makeUpdate(ME, "from rival", "player", OTHER, "Rival", {
        id: OTHER,
        name: "Rival",
      }),
      makeUpdate(ME, "from ally", "player", THIRD, "Ally", {
        id: THIRD,
        name: "Ally",
      }),
    ]);
    el.tick();
    await el.updateComplete;

    const labels = tabLabels(el);
    expect(labels.some((l) => l.includes("Rival"))).toBe(true);
    expect(labels.some((l) => l.includes("Ally"))).toBe(true);

    // Only the active (All) tab's log is shown, so neither whisper is visible.
    expect(el.querySelector("#text-chat-log")?.textContent).not.toContain(
      "from rival",
    );
    expect(el.querySelector("#text-chat-log")?.textContent).not.toContain(
      "from ally",
    );
  });

  test("messages land in their own thread's log", async () => {
    const el = await mountPanel([
      makeUpdate(ME, "from rival", "player", OTHER, "Rival", {
        id: OTHER,
        name: "Rival",
      }),
      makeUpdate(ME, "from ally", "player", THIRD, "Ally", {
        id: THIRD,
        name: "Ally",
      }),
    ]);
    el.tick();
    await el.updateComplete;

    const rivalTab = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Rival"),
    )!;
    rivalTab.click();
    await el.updateComplete;

    const log = el.querySelector("#text-chat-log")!;
    expect(log.textContent).toContain("from rival");
    expect(log.textContent).not.toContain("from ally");
  });

  test("an unread message marks its own tab, not the active one", async () => {
    const el = await mountPanel([
      makeUpdate(ME, "psst", "player", OTHER, "Rival", {
        id: OTHER,
        name: "Rival",
      }),
    ]);
    el.tick();
    await el.updateComplete;

    // Active tab is All; the badge belongs on the Rival tab.
    const rivalTab = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Rival"),
    )!;
    expect(rivalTab.textContent).toContain("1");
  });

  test("opening a tab clears its unread badge", async () => {
    const el = await mountPanel([
      makeUpdate(ME, "psst", "player", OTHER, "Rival", {
        id: OTHER,
        name: "Rival",
      }),
    ]);
    el.tick();
    await el.updateComplete;

    const rivalTab = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Rival"),
    )!;
    rivalTab.click();
    await el.updateComplete;

    const after = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Rival"),
    )!;
    expect(after.textContent?.replace(/\s+/g, "")).not.toMatch(/Rival.*1/);
  });

  test("own messages never count as unread", async () => {
    const el = await mountPanel([
      makeUpdate(ME, "mine", "player", ME, "Me", { id: OTHER, name: "Rival" }),
    ]);
    el.tick();
    await el.updateComplete;

    const rivalTab = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Rival"),
    )!;
    expect(rivalTab.textContent).not.toContain("1");
  });

  test("a whisper tab can be closed, All and Team cannot", async () => {
    const el = await mountPanel([
      makeUpdate(ME, "psst", "player", OTHER, "Rival", {
        id: OTHER,
        name: "Rival",
      }),
    ]);
    el.tick();
    await el.updateComplete;

    const close = Array.from(el.querySelectorAll('[role="button"]')).find((s) =>
      s.closest("button")?.textContent?.includes("Rival"),
    )!;
    (close as HTMLElement).click();
    await el.updateComplete;

    expect(tabLabels(el).some((l) => l.includes("Rival"))).toBe(false);
    // The permanent tabs survive and carry no close affordance.
    expect(tabLabels(el).some((l) => l.includes("channel_all"))).toBe(true);
    expect(el.querySelectorAll('[role="button"]')).toHaveLength(0);
  });
});

describe("TextChatPanel composer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("Enter opens the composer and focuses the input", async () => {
    const el = await mountPanel();
    await openComposer(el);

    const input = el.querySelector("#text-chat-input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  test("Enter does not hijack typing in another input", async () => {
    const el = await mountPanel();
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    expect(el.querySelector("#text-chat-input")).toBeNull();
  });

  test("sending emits a text chat intent and clears the draft", async () => {
    const el = await mountPanel();
    const sent: SendTextChatEvent[] = [];
    el.eventBus.on(SendTextChatEvent, (e) => sent.push(e));

    await openComposer(el);
    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.value = "good luck";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("good luck");
    expect(sent[0].channel).toBe("all");
    expect(
      (el.querySelector("#text-chat-input") as HTMLInputElement).value,
    ).toBe("");
  });

  test("an empty message sends nothing and closes the composer", async () => {
    const el = await mountPanel();
    const sent: SendTextChatEvent[] = [];
    el.eventBus.on(SendTextChatEvent, (e) => sent.push(e));

    await openComposer(el);
    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    expect(sent).toHaveLength(0);
    expect(el.querySelector("#text-chat-input")).toBeNull();
  });

  test("the send channel follows the active tab", async () => {
    const el = await mountPanel();
    const sent: SendTextChatEvent[] = [];
    el.eventBus.on(SendTextChatEvent, (e) => sent.push(e));

    const teamTab = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("channel_team"),
    )!;
    teamTab.click();
    await el.updateComplete;

    await openComposer(el);
    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.value = "regroup";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    expect(sent[0].channel).toBe("team");
  });

  test("Tab walks through the open conversations", async () => {
    const el = await mountPanel();
    await openComposer(el);

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    await el.updateComplete;
    expect(el.channel).toBe("team");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    await el.updateComplete;
    expect(el.channel).toBe("all");
  });

  test("each tab keeps its own half-typed draft", async () => {
    // Switching to answer a whisper must not eat the sentence being written.
    const el = await mountPanel();
    await openComposer(el);

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.value = "half a sentence";
    input.dispatchEvent(new Event("input"));

    const teamTab = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("channel_team"),
    )!;
    teamTab.click();
    await el.updateComplete;
    expect(
      (el.querySelector("#text-chat-input") as HTMLInputElement).value,
    ).toBe("");

    const allTab = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("channel_all"),
    )!;
    allTab.click();
    await el.updateComplete;
    expect(
      (el.querySelector("#text-chat-input") as HTMLInputElement).value,
    ).toBe("half a sentence");
  });

  test("Escape closes the composer", async () => {
    const el = await mountPanel();
    await openComposer(el);

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await el.updateComplete;

    expect(el.querySelector("#text-chat-input")).toBeNull();
  });

  test("keys typed into the composer do not reach game hotkey handlers", async () => {
    const el = await mountPanel();
    await openComposer(el);

    // A hotkey listener on window must not see keystrokes meant for the input,
    // or typing "b" would open the build menu mid-message.
    const seen: string[] = [];
    window.addEventListener("keydown", (e) => seen.push(e.key));

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", bubbles: true }),
    );

    expect(seen).not.toContain("b");
  });

  test("startWhisper opens the thread and sends to that player", async () => {
    const el = await mountPanel();
    const sent: SendTextChatEvent[] = [];
    el.eventBus.on(SendTextChatEvent, (e) => sent.push(e));

    el.startWhisper({
      smallID: () => OTHER,
      id: () => `player-${OTHER}`,
      displayName: () => "Rival",
    } as never);
    await el.updateComplete;

    expect(el.channel).toBe("player");
    expect(tabLabels(el).some((l) => l.includes("Rival"))).toBe(true);

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.value = "meet me north";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("player");
    expect(sent[0].recipient).toBe(`player-${OTHER}`);
  });

  test("startWhisper twice reuses the same tab", async () => {
    const el = await mountPanel();
    const target = {
      smallID: () => OTHER,
      id: () => `player-${OTHER}`,
      displayName: () => "Rival",
    } as never;

    el.startWhisper(target);
    await el.updateComplete;
    el.startWhisper(target);
    await el.updateComplete;

    expect(tabLabels(el).filter((l) => l.includes("Rival"))).toHaveLength(1);
  });

  test("a whisper to a departed player falls back to all-chat", async () => {
    // The sim would silently drop it, losing the message.
    const el = await mountPanel();
    // Stub a game where the peer can no longer be resolved.
    el.game = {
      myPlayer: () => ({ smallID: () => ME, id: () => "me" }),
      playerBySmallID: () => null,
      updatesSinceLastTick: () => null,
    } as never;

    const sent: SendTextChatEvent[] = [];
    el.eventBus.on(SendTextChatEvent, (e) => sent.push(e));

    el.startWhisper({
      smallID: () => OTHER,
      id: () => `player-${OTHER}`,
      displayName: () => "Rival",
    } as never);
    await el.updateComplete;

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.value = "anyone?";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("all");
    expect(sent[0].recipient).toBeUndefined();
  });
});
