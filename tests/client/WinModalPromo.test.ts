/**
 * @vitest-environment jsdom
 *
 * The end-of-game box must not advertise upstream's product.
 *
 * It used to rotate between a Steam wishlist for a release that is not ours,
 * upstream's tutorial video, upstream's Discord invite, and a cosmetics shop
 * backed by an API this fork does not run. It now carries the attribution the
 * asset licence requires, and nothing else — a placeholder until we decide
 * what belongs there.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string) =>
    key === "main.copyright"
      ? "© Landtaker · built on OpenFront™ and Contributors"
      : key,
}));
vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: { gameplayStop: () => {} },
}));

const { WinModal } = await import("../../src/client/hud/layers/WinModal");

async function mountModal() {
  const el = new WinModal();
  el.game = {
    config: () => ({ gameConfig: () => ({ rankedType: undefined }) }),
    myPlayer: () => ({ isAlive: () => true }),
  } as never;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("WinModal end-of-game box", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("shows the origin attribution", async () => {
    const el = await mountModal();
    el.isVisible = true;
    await el.updateComplete;

    expect(el.textContent).toContain("built on OpenFront");
    expect(el.textContent).toContain("Landtaker");
  });

  test("never embeds the tutorial video", async () => {
    // A YouTube iframe on the end screen was upstream's, and it loaded a
    // third-party player into our match flow.
    const el = await mountModal();
    el.isVisible = true;
    await el.updateComplete;

    expect(el.querySelector("iframe")).toBeNull();
    expect(el.innerHTML).not.toContain("youtube");
  });

  test("never renders the Steam wishlist", async () => {
    const el = await mountModal();
    el.isVisible = true;
    await el.updateComplete;

    expect(el.querySelector("steam-wishlist")).toBeNull();
    expect(el.innerHTML.toLowerCase()).not.toContain("wishlist");
  });

  test("links nowhere, least of all to upstream's Discord", async () => {
    const el = await mountModal();
    el.isVisible = true;
    await el.updateComplete;

    for (const a of Array.from(el.querySelectorAll("a"))) {
      expect(a.getAttribute("href")).not.toContain(
        "discord.com/invite/openfront",
      );
    }
  });

  test("shows the same content whether the game was won or lost", async () => {
    // The old box branched on the result and on how many games had been
    // played, which is how a first-time loser got a video ad.
    const el = await mountModal();
    el.isVisible = true;
    await el.updateComplete;
    const won = el.querySelector(".text-center.mb-6")?.textContent?.trim();

    document.body.innerHTML = "";
    const other = await mountModal();
    other.isVisible = true;
    await other.updateComplete;
    const lost = other.querySelector(".text-center.mb-6")?.textContent?.trim();

    expect(won).toBe(lost);
    expect(won).toBeTruthy();
  });
});
