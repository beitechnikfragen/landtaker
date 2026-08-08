import { afterEach, describe, expect, it } from "vitest";
import { modalRouter } from "../../src/client/ModalRouter";

// Main.ts's /history branch (handleUrl) relies on modalRouter.isHashRouted()
// to decide whether to still route a #modal=... hash after showing the
// history page, instead of returning early and swallowing it. These tests
// guard that decision point directly, since Main.ts itself can't be
// imported in Vitest (it runs bootstrap() at module scope).
describe("modalRouter.isHashRouted", () => {
  const originalHash = window.location.hash;

  afterEach(() => {
    history.replaceState(
      history.state,
      "",
      window.location.pathname + window.location.search + originalHash,
    );
  });

  it("is true for a #modal=... hash", () => {
    history.replaceState(
      history.state,
      "",
      "/history#modal=stats&gameID=abc123",
    );
    expect(modalRouter.isHashRouted()).toBe(true);
  });

  it("is false when there is no hash", () => {
    history.replaceState(history.state, "", "/history");
    expect(modalRouter.isHashRouted()).toBe(false);
  });

  it("is false for a non-modal hash", () => {
    history.replaceState(history.state, "", "/history#affiliate=abc");
    expect(modalRouter.isHashRouted()).toBe(false);
  });
});
