/**
 * @vitest-environment jsdom
 *
 * Panel-level tests for the in-game chat.
 *
 * The renderer refuses a software WebGL2 context on purpose, so a real match
 * cannot be driven headlessly. These drive the component directly against a
 * stub GameView instead, covering the parts the core tests cannot: that a
 * player only ever renders messages addressed to them, that the composer takes
 * keys away from the game while typing, and that the right intent is emitted.
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

function makeUpdate(
  recipientID: number,
  text: string,
  channel: TextChatChannel = "all",
  senderID = OTHER,
  senderName = "Rival",
) {
  return {
    type: GameUpdateType.DisplayTextChatEvent,
    text,
    channel,
    senderID,
    senderName,
    recipientID,
  };
}

/** A GameView stub exposing only what the panel touches. */
function makeGame(updates: unknown[]) {
  let consumed = false;
  return {
    myPlayer: () => ({ smallID: () => ME, id: () => "me" }),
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

  test("renders the channel label for each channel", async () => {
    const el = await mountPanel([
      makeUpdate(ME, "to everyone", "all"),
      makeUpdate(ME, "to the team", "team"),
    ]);
    el.tick();
    await el.updateComplete;

    expect(el.textContent).toContain("text_chat.channel_all");
    expect(el.textContent).toContain("text_chat.channel_team");
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

describe("TextChatPanel composer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("Enter opens the composer and focuses the input", async () => {
    const el = await mountPanel();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

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

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

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

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    expect(sent).toHaveLength(0);
    expect(el.querySelector("#text-chat-input")).toBeNull();
  });

  test("Tab cycles between all and team", async () => {
    const el = await mountPanel();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    await el.updateComplete;
    expect(el.channel).toBe("team");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    await el.updateComplete;
    expect(el.channel).toBe("all");
  });

  test("Escape closes the composer", async () => {
    const el = await mountPanel();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await el.updateComplete;

    expect(el.querySelector("#text-chat-input")).toBeNull();
  });

  test("keys typed into the composer do not reach game hotkey handlers", async () => {
    const el = await mountPanel();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

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

  test("startWhisper targets a player and opens the composer", async () => {
    const el = await mountPanel();
    const sent: SendTextChatEvent[] = [];
    el.eventBus.on(SendTextChatEvent, (e) => sent.push(e));

    el.startWhisper({
      id: () => "rival-id",
      displayName: () => "Rival",
    } as never);
    await el.updateComplete;

    expect(el.channel).toBe("player");

    const input = el.querySelector("#text-chat-input") as HTMLInputElement;
    input.value = "meet me north";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("player");
    expect(sent[0].recipient).toBe("rival-id");
  });

  test("a whisper with no target falls back to all-chat", async () => {
    // The sim would silently drop a targetless whisper, losing the message.
    const el = await mountPanel();
    const sent: SendTextChatEvent[] = [];
    el.eventBus.on(SendTextChatEvent, (e) => sent.push(e));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await el.updateComplete;
    el.channel = "player" as TextChatChannel;
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
