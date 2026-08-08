import { matchHistoryPath } from "../src/client/HistoryRoute";

describe("matchHistoryPath", () => {
  it("matches the bare history path", () => {
    expect(matchHistoryPath("/history")).toBe(true);
  });

  it("matches with a worker prefix", () => {
    expect(matchHistoryPath("/w1/history")).toBe(true);
    expect(matchHistoryPath("/w12/history")).toBe(true);
  });

  it("tolerates a trailing slash", () => {
    expect(matchHistoryPath("/history/")).toBe(true);
  });

  it("does not match other paths", () => {
    expect(matchHistoryPath("/")).toBe(false);
    expect(matchHistoryPath("/game/abc123")).toBe(false);
    expect(matchHistoryPath("/history-of-everything")).toBe(false);
    expect(matchHistoryPath("/w1/game/abc")).toBe(false);
  });
});
