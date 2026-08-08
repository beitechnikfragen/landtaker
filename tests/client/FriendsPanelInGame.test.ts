/**
 * @vitest-environment jsdom
 *
 * The social dock's in-game behaviour and party presence.
 *
 * Entering a match is a class toggle on <body> with no event, so the dock
 * observes it. These pin the two things that make it usable during a game:
 * it stays reachable, and it does not land on top of the chat panel or open
 * itself over the map.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));
// The panel starts network work on mount; none of it is under test here.
vi.mock("../../src/client/FriendsApi", () => ({
  connectFriendsStream: () => ({ close: () => {} }),
  fetchFriends: async () => ({ results: [] }),
  fetchFriendRequests: async () => ({ incoming: [], outgoing: [] }),
  fetchMessages: async () => [],
  sendChatMessage: async () => ({ ok: true }),
  sendFriendRequest: async () => ({ ok: true }),
  acceptFriendRequest: async () => ({ ok: true }),
  deleteFriendRequest: async () => ({ ok: true }),
}));
vi.mock("../../src/client/PartyApi", () => ({
  connectPartyStream: () => ({ close: () => {} }),
  createParty: async () => ({ ok: false }),
  joinParty: async () => ({ ok: false }),
  leaveParty: async () => ({ ok: true }),
  kickFromParty: async () => ({ ok: true }),
  invitePartyMember: async () => ({ ok: true }),
  sendPartyChat: async () => ({ ok: true }),
}));
vi.mock("../../src/client/Api", () => ({
  hasLinkedAccount: () => true,
}));

const { FriendsPanel } =
  await import("../../src/client/components/FriendsPanel");

/** Mounts the dock as a signed-in user, which is what makes it render at all. */
async function mountPanel() {
  const el = new FriendsPanel();
  document.body.appendChild(el);
  // linked() gates all rendering; the panel reads this off the userMe payload.
  (el as unknown as { userMeResponse: unknown }).userMeResponse = {
    player: { publicId: "me" },
    user: { discord: { id: "1" } },
  };
  el.requestUpdate();
  await el.updateComplete;
  return el;
}

/** The dock's positioned container. */
function container(el: HTMLElement): HTMLElement | null {
  return el.querySelector("div.fixed");
}

async function setInGame(
  el: { updateComplete: Promise<unknown> },
  on: boolean,
) {
  document.body.classList.toggle("in-game", on);
  // MutationObserver callbacks are delivered as a microtask.
  await Promise.resolve();
  await el.updateComplete;
}

describe("FriendsPanel in game", () => {
  beforeEach(() => {
    document.body.className = "";
    document.body.innerHTML = "";
    localStorage.clear();
  });

  test("stays rendered during a match", async () => {
    const el = await mountPanel();
    await setInGame(el, true);

    // Previously the dock was hidden outright by an in-[.in-game]:!hidden rule.
    expect(container(el)).not.toBeNull();
    expect(container(el)!.className).not.toContain("in-game]:!hidden");
  });

  test("moves to the opposite corner from the chat panel in game", async () => {
    const el = await mountPanel();

    const menu = container(el)!.className;
    expect(menu).toContain("right-[72px]");

    await setInGame(el, true);
    const game = container(el)!.className;
    // The chat panel occupies the bottom-right in game, so the dock must not.
    expect(game).toContain("left-4");
    expect(game).not.toContain("right-[72px]");
  });

  test("returns to its menu position when the match ends", async () => {
    const el = await mountPanel();
    await setInGame(el, true);
    await setInGame(el, false);

    expect(container(el)!.className).toContain("right-[72px]");
    expect(container(el)!.className).not.toContain("left-4");
  });

  test("enters a match collapsed even if left open in the menu", async () => {
    localStorage.setItem("friendsPanelOpen", "1");
    const el = await mountPanel();
    expect((el as unknown as { open: boolean }).open).toBe(true);

    await setInGame(el, true);
    // The panel expands upward over the map; opening itself there would cover
    // the very thing the player just loaded.
    expect((el as unknown as { open: boolean }).open).toBe(false);
  });

  test("collapsing on entry does not overwrite the saved preference", async () => {
    localStorage.setItem("friendsPanelOpen", "1");
    const el = await mountPanel();
    await setInGame(el, true);

    // Leaving the game should restore what the player chose in the menu.
    expect(localStorage.getItem("friendsPanelOpen")).toBe("1");
  });

  test("stops observing body classes once removed", async () => {
    const el = await mountPanel();
    el.remove();
    await Promise.resolve();

    // A leaked observer would keep firing against a detached element.
    expect(
      (el as unknown as { bodyClassObserver: unknown }).bodyClassObserver,
    ).toBeNull();
  });
});
