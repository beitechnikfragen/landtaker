# Game History Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the existing game history a standalone `/history` page with aggregate KPIs, and surface the per-game stats that are already archived but never displayed.

**Architecture:** A new Lit page component reuses the existing `<player-game-history-view>` unchanged and adds a metrics header above it, computed by a pure function from the games the list already emits via its `history-updated` event. The per-game detail view (`GameInfoView` / `Ranking`) is extended with `PlayerStats` fields that are recorded but currently dropped. Replay itself is untouched — it already works.

**Tech Stack:** TypeScript 5.7, Lit (LitElement), Tailwind CSS 4, Vitest, Zod.

Spec: `docs/superpowers/specs/2026-08-08-game-history-page-design.md`

## Global Constraints

- **No `src/core` changes are planned.** If a task turns out to need one, that change **must** ship with tests (project rule, `CLAUDE.md`).
- **All user-visible text** goes through `translateText()` from `src/client/Utils.ts` and gets a key in `resources/lang/en.json`. **Do not modify any other file under `resources/lang/`** — Crowdin owns them.
- `resources/lang/en.json` **must stay alphabetically sorted** — there is a test enforcing this (`tests/EnJsonSorted.test.ts`). Run it after every edit to that file.
- Install deps with `npm run inst` (`npm ci --ignore-scripts`), **never** `npm install`.
- Lit components in this codebase override `createRenderRoot() { return this; }` to opt out of shadow DOM so Tailwind classes apply. Every new component must do the same.
- `PlayerStats` numeric fields are `bigint`. Convert with `Number(...)` at the display boundary; never mix `bigint` and `number` in arithmetic.
- Every `PlayerStats` field is optional. A field that is absent renders as `"—"`, never `0`.
- Run `npm run lint` and `npm run format` before each commit.

---

## File Structure

**Create:**

- `src/client/components/baseComponents/stats/GameHistoryMetrics.ts` — pure aggregation function + types. No DOM, no state.
- `src/client/components/baseComponents/stats/GameHistoryMetricsHeader.ts` — `<game-history-metrics-header>`, renders the metrics.
- `src/client/GameHistoryPage.ts` — `<game-history-page>`, the page shell: owns `publicId`, hosts the header + existing list, wires `view-game` / `view-stats`.
- `tests/GameHistoryMetrics.test.ts`
- `tests/GameHistoryRoute.test.ts`

**Modify:**

- `src/client/components/baseComponents/ranking/GameInfoRanking.ts` — extend `PlayerInfo`, add `RankType` members + label keys + scoring.
- `src/client/components/baseComponents/ranking/PlayerRow.ts` — render the new rank types.
- `src/client/Main.ts:200-248` — register the `history` modal route; `Main.ts:837` — add the `/history` path branch.
- `src/client/GameStatsModal.ts` — add `openFromHistory()` and a back branch.
- `index.html` — mount `<game-history-page id="page-history">`; add the nav entry.
- `resources/lang/en.json` — new keys.
- `tests/GameInfoRanking.test.ts` — cover the new rank types.

---

## Task 1: Metrics aggregation function

The pure core of the header. Built first and in isolation because every honesty rule in the spec lives here.

**Files:**

- Create: `src/client/components/baseComponents/stats/GameHistoryMetrics.ts`
- Test: `tests/GameHistoryMetrics.test.ts`

**Interfaces:**

- Consumes: `PublicPlayerGame` from `src/core/ApiSchemas.ts` — fields used: `gameId: string`, `map: string | null`, `durationSeconds: number | null`, `result: "victory" | "defeat" | "incomplete"`.
- Produces:

  ```ts
  export interface HistoryMetrics {
    totalGames: number;
    decidedGames: number; // victory + defeat, excludes incomplete
    wins: number;
    winRate: number | null; // null when decidedGames === 0
    avgDurationSeconds: number | null; // null when no game has a duration
    bestMap: { map: string; winRate: number; games: number } | null;
    form: ("victory" | "defeat" | "incomplete")[]; // newest first, max 10
  }
  export const BEST_MAP_MIN_GAMES = 3;
  export function computeHistoryMetrics(
    games: PublicPlayerGame[],
  ): HistoryMetrics;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/GameHistoryMetrics.test.ts`:

```ts
import {
  BEST_MAP_MIN_GAMES,
  computeHistoryMetrics,
} from "../src/client/components/baseComponents/stats/GameHistoryMetrics";
import type { PublicPlayerGame } from "../src/core/ApiSchemas";

function game(over: Partial<PublicPlayerGame> = {}): PublicPlayerGame {
  return {
    gameId: "g1",
    start: "2026-08-08T10:00:00.000Z",
    durationSeconds: 600,
    map: "Montreal",
    mode: "ffa",
    type: "public",
    playerTeams: null,
    rankedType: null,
    result: "victory",
    totalPlayers: 20,
    username: "Alice",
    clanTag: null,
    ...over,
  } as PublicPlayerGame;
}

describe("computeHistoryMetrics", () => {
  it("returns an empty shape for no games", () => {
    const m = computeHistoryMetrics([]);
    expect(m.totalGames).toBe(0);
    expect(m.winRate).toBeNull();
    expect(m.avgDurationSeconds).toBeNull();
    expect(m.bestMap).toBeNull();
    expect(m.form).toEqual([]);
  });

  it("computes win rate over decided games only", () => {
    const m = computeHistoryMetrics([
      game({ result: "victory" }),
      game({ result: "defeat" }),
      game({ result: "victory" }),
    ]);
    expect(m.totalGames).toBe(3);
    expect(m.decidedGames).toBe(3);
    expect(m.wins).toBe(2);
    expect(m.winRate).toBeCloseTo(2 / 3);
  });

  it("excludes incomplete games from win rate but counts them in total", () => {
    const m = computeHistoryMetrics([
      game({ result: "victory" }),
      game({ result: "incomplete" }),
      game({ result: "incomplete" }),
    ]);
    expect(m.totalGames).toBe(3);
    expect(m.decidedGames).toBe(1);
    expect(m.winRate).toBe(1);
  });

  it("returns null win rate when every game is incomplete", () => {
    const m = computeHistoryMetrics([game({ result: "incomplete" })]);
    expect(m.winRate).toBeNull();
  });

  it("averages duration ignoring null durations", () => {
    const m = computeHistoryMetrics([
      game({ durationSeconds: 100 }),
      game({ durationSeconds: 200 }),
      game({ durationSeconds: null }),
    ]);
    expect(m.avgDurationSeconds).toBe(150);
  });

  it("returns null average when no game has a duration", () => {
    const m = computeHistoryMetrics([game({ durationSeconds: null })]);
    expect(m.avgDurationSeconds).toBeNull();
  });

  it("requires a minimum number of games before naming a best map", () => {
    const below = computeHistoryMetrics([
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
    ]);
    expect(below.bestMap).toBeNull();

    const atThreshold = computeHistoryMetrics([
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "defeat" }),
    ]);
    expect(atThreshold.bestMap).toEqual({
      map: "Europe",
      winRate: 2 / 3,
      games: 3,
    });
    expect(BEST_MAP_MIN_GAMES).toBe(3);
  });

  it("picks the map with the highest win rate among qualifying maps", () => {
    const m = computeHistoryMetrics([
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
      game({ map: "Asia", result: "victory" }),
      game({ map: "Asia", result: "defeat" }),
      game({ map: "Asia", result: "defeat" }),
    ]);
    expect(m.bestMap?.map).toBe("Europe");
  });

  it("counts only decided games toward a map's threshold", () => {
    const m = computeHistoryMetrics([
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "victory" }),
      game({ map: "Europe", result: "incomplete" }),
    ]);
    expect(m.bestMap).toBeNull();
  });

  it("ignores games with no map", () => {
    const m = computeHistoryMetrics([
      game({ map: null, result: "victory" }),
      game({ map: null, result: "victory" }),
      game({ map: null, result: "victory" }),
    ]);
    expect(m.bestMap).toBeNull();
  });

  it("caps the form list at 10, preserving input order", () => {
    const games = Array.from({ length: 14 }, (_, i) =>
      game({ gameId: `g${i}`, result: i === 0 ? "defeat" : "victory" }),
    );
    const m = computeHistoryMetrics(games);
    expect(m.form).toHaveLength(10);
    expect(m.form[0]).toBe("defeat");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest tests/GameHistoryMetrics.test.ts --run
```

Expected: FAIL — cannot resolve `GameHistoryMetrics`.

- [ ] **Step 3: Write the implementation**

Create `src/client/components/baseComponents/stats/GameHistoryMetrics.ts`:

```ts
import type { PublicPlayerGame } from "../../../../core/ApiSchemas";

// A map needs this many *decided* games before it can be called a best map.
// Below it, "100%" off a single win is noise rather than a signal.
export const BEST_MAP_MIN_GAMES = 3;

// How many recent results the form strip shows.
const FORM_LENGTH = 10;

export type GameResult = "victory" | "defeat" | "incomplete";

export interface HistoryMetrics {
  totalGames: number;
  decidedGames: number;
  wins: number;
  winRate: number | null;
  avgDurationSeconds: number | null;
  bestMap: { map: string; winRate: number; games: number } | null;
  form: GameResult[];
}

// Aggregates the games currently loaded in the list. Incomplete games count
// toward totals but never toward win rate — folding abandoned games into
// defeats would systematically depress it.
export function computeHistoryMetrics(
  games: PublicPlayerGame[],
): HistoryMetrics {
  let wins = 0;
  let decidedGames = 0;
  let durationSum = 0;
  let durationCount = 0;
  const perMap = new Map<string, { wins: number; decided: number }>();

  for (const game of games) {
    const decided = game.result === "victory" || game.result === "defeat";
    if (decided) {
      decidedGames++;
      if (game.result === "victory") wins++;
    }

    if (game.durationSeconds !== null) {
      durationSum += game.durationSeconds;
      durationCount++;
    }

    if (game.map !== null && decided) {
      const entry = perMap.get(game.map) ?? { wins: 0, decided: 0 };
      entry.decided++;
      if (game.result === "victory") entry.wins++;
      perMap.set(game.map, entry);
    }
  }

  let bestMap: HistoryMetrics["bestMap"] = null;
  for (const [map, entry] of perMap) {
    if (entry.decided < BEST_MAP_MIN_GAMES) continue;
    const winRate = entry.wins / entry.decided;
    if (bestMap === null || winRate > bestMap.winRate) {
      bestMap = { map, winRate, games: entry.decided };
    }
  }

  return {
    totalGames: games.length,
    decidedGames,
    wins,
    winRate: decidedGames === 0 ? null : wins / decidedGames,
    avgDurationSeconds:
      durationCount === 0 ? null : durationSum / durationCount,
    bestMap,
    form: games.slice(0, FORM_LENGTH).map((g) => g.result),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest tests/GameHistoryMetrics.test.ts --run
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
npm run lint && npm run format
```

```bash
git add src/client/components/baseComponents/stats/GameHistoryMetrics.ts tests/GameHistoryMetrics.test.ts && git commit -m "feat(history): aggregate metrics over loaded games"
```

---

## Task 2: Metrics header component

**Files:**

- Create: `src/client/components/baseComponents/stats/GameHistoryMetricsHeader.ts`
- Modify: `resources/lang/en.json`

**Interfaces:**

- Consumes: `computeHistoryMetrics`, `HistoryMetrics` (Task 1); `renderDuration`, `getMapName`, `translateText` from `src/client/Utils.ts`.
- Produces: custom element `<game-history-metrics-header>` with one property, `.games: PublicPlayerGame[]`. It computes metrics itself — the host passes raw games.

- [ ] **Step 1: Add translation keys**

In `resources/lang/en.json`, add a `game_history` object. **Insert it in alphabetical position** among the existing top-level keys, and keep the keys inside it alphabetical:

```json
  "game_history": {
    "avg_duration": "Avg. duration",
    "best_map": "Best map",
    "form": "Recent form",
    "games": "Games",
    "no_data": "—",
    "not_signed_in": "Sign in to see your match history.",
    "page_title": "Match history",
    "scope_note": "Based on the {games} matches loaded below.",
    "win_rate": "Win rate"
  },
```

- [ ] **Step 2: Verify the sort test still passes**

```bash
npx vitest tests/EnJsonSorted.test.ts --run
```

Expected: PASS. If it fails, fix the placement it reports.

- [ ] **Step 3: Write the component**

Create `src/client/components/baseComponents/stats/GameHistoryMetricsHeader.ts`:

```ts
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { PublicPlayerGame } from "../../../../core/ApiSchemas";
import { getMapName, renderDuration, translateText } from "../../../Utils";
import {
  computeHistoryMetrics,
  type GameResult,
  type HistoryMetrics,
} from "./GameHistoryMetrics";

@customElement("game-history-metrics-header")
export class GameHistoryMetricsHeader extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) games: PublicPlayerGame[] = [];

  render(): TemplateResult {
    if (this.games.length === 0) return html``;
    const metrics = computeHistoryMetrics(this.games);
    return html`
      <div class="bg-white/5 border border-lt-700 p-4 space-y-3">
        <div
          class="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 justify-items-center text-center"
        >
          ${this.renderTile(
            translateText("game_history.games"),
            `${metrics.totalGames}`,
          )}
          ${this.renderTile(
            translateText("game_history.win_rate"),
            metrics.winRate === null
              ? translateText("game_history.no_data")
              : `${Math.round(metrics.winRate * 100)}%`,
          )}
          ${this.renderTile(
            translateText("game_history.avg_duration"),
            metrics.avgDurationSeconds === null
              ? translateText("game_history.no_data")
              : renderDuration(Math.round(metrics.avgDurationSeconds)),
          )}
          ${this.renderTile(
            translateText("game_history.best_map"),
            metrics.bestMap === null
              ? translateText("game_history.no_data")
              : (getMapName(metrics.bestMap.map) ?? metrics.bestMap.map),
          )}
        </div>
        ${this.renderForm(metrics)}
        <p class="text-[11px] text-white/40 text-center">
          ${translateText("game_history.scope_note", {
            games: `${metrics.totalGames}`,
          })}
        </p>
      </div>
    `;
  }

  private renderTile(label: string, value: string): TemplateResult {
    return html`
      <div class="min-w-0">
        <div
          class="text-[10px] font-bold uppercase tracking-wider text-lt-500 mb-0.5"
        >
          ${label}
        </div>
        <div class="text-sm text-white truncate" title=${value}>${value}</div>
      </div>
    `;
  }

  private renderForm(metrics: HistoryMetrics): TemplateResult {
    if (metrics.form.length === 0) return html``;
    return html`
      <div class="flex items-center justify-center gap-2">
        <span
          class="text-[10px] font-bold uppercase tracking-wider text-lt-500"
        >
          ${translateText("game_history.form")}
        </span>
        <div class="flex gap-1">
          ${metrics.form.map((result) => this.renderFormDot(result))}
        </div>
      </div>
    `;
  }

  private renderFormDot(result: GameResult): TemplateResult {
    const tint =
      result === "victory"
        ? "bg-green-600"
        : result === "defeat"
          ? "bg-lt-bad"
          : "bg-gray-500";
    return html`<span
      class="inline-block w-2.5 h-2.5 rounded-full ${tint}"
      title=${result}
    ></span>`;
  }
}
```

- [ ] **Step 4: Confirm `translateText` supports interpolation**

`scope_note` uses a `{games}` placeholder. Verify the signature:

```bash
grep -n "export function translateText" -A 12 src/client/Utils.ts
```

If it does **not** take a second params argument, change `scope_note` to a plain string without the placeholder (e.g. `"Based on the matches loaded below."`) and drop the second argument from the call. Do not invent an interpolation helper.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
```

Expected: no errors from the new files.

```bash
npm run lint && npm run format
```

```bash
git add src/client/components/baseComponents/stats/GameHistoryMetricsHeader.ts resources/lang/en.json && git commit -m "feat(history): metrics header component"
```

---

## Task 3: The page component

**Files:**

- Create: `src/client/GameHistoryPage.ts`
- Modify: `index.html`, `resources/lang/en.json`

**Interfaces:**

- Consumes: `<game-history-metrics-header>` (Task 2); the existing `<player-game-history-view>` and its `PlayerGameHistoryCache` type from `src/client/components/baseComponents/stats/PlayerGameHistoryView.ts`; `getUserMe` from `src/client/Api.ts`; `ClientEnv` from `src/client/ClientEnv.ts`.
- Produces: custom element `<game-history-page>` with `public open(args?: Record<string, unknown>): void`, `public close(): void`, and `public returnToGames(): void` (called by `GameStatsModal` when navigating back — Task 4).

**Reference wiring (copy the event handling exactly):** `src/client/AccountModal.ts:490-503` for the list host, `AccountModal.ts:672-678` for `openGameStats`, `AccountModal.ts:660-670` for `viewGame`.

- [ ] **Step 1: Add translation keys**

`game_history.page_title` and `game_history.not_signed_in` were added in Task 2 — no new keys needed. Verify they exist:

```bash
grep -n "not_signed_in\|page_title" resources/lang/en.json
```

- [ ] **Step 2: Write the component**

Create `src/client/GameHistoryPage.ts`:

```ts
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { UserMeResponse } from "../core/ApiSchemas";
import { getUserMe } from "./Api";
import { ClientEnv } from "./ClientEnv";
import type { PlayerGameHistoryCache } from "./components/baseComponents/stats/PlayerGameHistoryView";
import "./components/baseComponents/stats/GameHistoryMetricsHeader";
import "./components/baseComponents/stats/PlayerGameHistoryView";
import { translateText } from "./Utils";

@customElement("game-history-page")
export class GameHistoryPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private publicId = "";
  @state() private historyCache: PlayerGameHistoryCache | null = null;

  connectedCallback() {
    super.connectedCallback();
    // Identity may already be known (Main fetches it at boot) or arrive later.
    document.addEventListener("userMeResponse", this.onUserMe);
    void this.loadIdentity();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("userMeResponse", this.onUserMe);
  }

  private onUserMe = (event: Event) => {
    const detail = (event as CustomEvent).detail as UserMeResponse | undefined;
    this.applyPublicId(detail?.player?.publicId ?? "");
  };

  private async loadIdentity(): Promise<void> {
    const me = await getUserMe();
    this.applyPublicId(me === false ? "" : (me.player?.publicId ?? ""));
  }

  // Drop the cached history when the identity changes, so one player's games
  // never linger into another's view.
  private applyPublicId(publicId: string): void {
    if (publicId === this.publicId) return;
    this.publicId = publicId;
    this.historyCache = null;
  }

  public open(_args?: Record<string, unknown>): void {
    void this.loadIdentity();
  }

  public close(): void {}

  // Called by GameStatsModal's back button.
  public returnToGames(): void {
    window.showPage?.("page-history");
  }

  render(): TemplateResult {
    return html`
      <div class="px-3 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-7 space-y-4">
        <h1
          class="text-lg font-bold uppercase tracking-widest text-white text-center"
        >
          ${translateText("game_history.page_title")}
        </h1>
        ${this.publicId ? this.renderHistory() : this.renderSignedOut()}
      </div>
    `;
  }

  private renderSignedOut(): TemplateResult {
    return html`
      <div class="bg-white/5 border border-lt-700 p-12 text-center">
        <p class="text-lt-400 text-sm">
          ${translateText("game_history.not_signed_in")}
        </p>
      </div>
    `;
  }

  private renderHistory(): TemplateResult {
    return html`
      <game-history-metrics-header
        .games=${this.historyCache?.games ?? []}
      ></game-history-metrics-header>
      <player-game-history-view
        .publicId=${this.publicId}
        .cachedState=${this.historyCache?.publicId === this.publicId
          ? this.historyCache
          : null}
        @history-updated=${(e: CustomEvent<PlayerGameHistoryCache>) => {
          this.historyCache = e.detail;
        }}
        @view-stats=${(e: CustomEvent<{ gameId: string }>) =>
          this.openGameStats(e.detail.gameId)}
        @view-game=${(e: CustomEvent<{ gameId: string }>) =>
          this.viewGame(e.detail.gameId)}
      ></player-game-history-view>
    `;
  }

  private openGameStats(gameId: string): void {
    const statsModal = document.querySelector<
      HTMLElement & { openFromHistory(gameId: string): void }
    >("game-stats-modal");
    statsModal?.openFromHistory(gameId);
  }

  // Same navigation the account modal performs: push the game URL and let
  // Main's join-changed listener route into the replay.
  private viewGame(gameId: string): void {
    const encodedGameId = encodeURIComponent(gameId);
    const newUrl = `/${ClientEnv.workerPath(gameId)}/game/${encodedGameId}`;
    history.pushState({ join: gameId }, "", newUrl);
    window.dispatchEvent(
      new CustomEvent("join-changed", { detail: { gameId: encodedGameId } }),
    );
  }
}
```

- [ ] **Step 3: Verify assumptions against the real code**

Three things above are copied from `AccountModal` and must be confirmed, not trusted:

```bash
grep -n "showPage" src/client/Navigation.ts | head -5
grep -n "workerPath" src/client/ClientEnv.ts
grep -n "publicId" src/core/ApiSchemas.ts | grep -i "userme\|player" | head -5
```

- If `window.showPage` is not declared on the `Window` type, import and call the `showPage` function from `src/client/Navigation.ts` directly instead of `window.showPage?.(...)`.
- Confirm `UserMeResponse` is exported from `src/core/ApiSchemas.ts`; if it lives elsewhere, fix the import path.

- [ ] **Step 4: Mount the page in `index.html`**

Find the block of `page-content` elements (around `index.html:209-307`, e.g. the `<game-stats-modal id="page-stats" ...>` line) and add alongside them:

```html
<game-history-page
  id="page-history"
  inline
  class="hidden w-full h-full page-content relative z-50"
></game-history-page>
```

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors. `openFromHistory` does not exist on `GameStatsModal` yet, but the call site is typed via a structural cast, so this compiles — Task 4 adds the method.

- [ ] **Step 6: Lint, format, commit**

```bash
npm run lint && npm run format
```

```bash
git add src/client/GameHistoryPage.ts index.html && git commit -m "feat(history): standalone history page component"
```

---

## Task 4: Route registration and stats back-navigation

Makes the page reachable and keeps the stats modal's back button honest.

**Files:**

- Modify: `src/client/Main.ts` (two places: ~200-248 and ~837), `src/client/GameStatsModal.ts`
- Test: `tests/GameHistoryRoute.test.ts`

**Interfaces:**

- Consumes: `<game-history-page>` (Task 3).
- Produces: `export function matchHistoryPath(pathname: string): boolean` in `src/client/Main.ts` — exported so it is testable without booting the client.

- [ ] **Step 1: Write the failing route test**

Create `tests/GameHistoryRoute.test.ts`:

```ts
import { matchHistoryPath } from "../src/client/Main";

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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest tests/GameHistoryRoute.test.ts --run
```

Expected: FAIL — `matchHistoryPath` is not exported.

If instead it fails because importing `Main.ts` executes browser-only side effects, **do not** stub the DOM. Move the function into a new `src/client/HistoryRoute.ts`, export it from there, import it into `Main.ts`, and update the test's import path. Note the move in the commit message.

- [ ] **Step 3: Add the matcher and the route branch**

In `src/client/Main.ts`, near the existing `/game/:id` regex (~line 837), add at module scope:

```ts
// Mirrors the optional worker prefix the game route allows (e.g. /w1/history),
// so the page resolves on worker hosts too.
const HISTORY_PATH_REGEX = /^\/(?:w\d+\/)?history\/?$/;

export function matchHistoryPath(pathname: string): boolean {
  return HISTORY_PATH_REGEX.test(pathname);
}
```

Then inside `handleUrl()`, **before** the existing `/game/` handling:

```ts
if (matchHistoryPath(window.location.pathname)) {
  window.showPage("page-history");
  return;
}
```

Match the surrounding code's early-return style; if `handleUrl` does not return early elsewhere, use the same `if/else if` chain it already uses rather than introducing a `return`.

- [ ] **Step 4: Register the hash route**

In `src/client/Main.ts`, in the `modalRouter.register` block (~line 200-248), add alphabetically near the others:

```ts
modalRouter.register("history", {
  tag: "game-history-page",
  pageId: "page-history",
});
```

- [ ] **Step 5: Import the page so it registers**

Ensure `Main.ts` imports the component for its side effect (near the other component imports):

```ts
import "./GameHistoryPage";
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest tests/GameHistoryRoute.test.ts --run
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Teach the stats modal to come back here**

In `src/client/GameStatsModal.ts`, extend the `openedFrom` union type to include `"history"`, then add next to `openFromAccount` (line ~59):

```ts
  public openFromHistory(gameId: string): void {
    this.openedFrom = "history";
    this.open({ gameID: gameId });
  }
```

And in `back()` (line ~76), add a branch alongside the existing ones:

```ts
    } else if (openedFrom === "history") {
      document
        .querySelector<
          HTMLElement & { returnToGames(): void }
        >("game-history-page")
        ?.returnToGames();
```

- [ ] **Step 8: Typecheck, lint, format, commit**

```bash
npx tsc --noEmit && npm run lint && npm run format
```

```bash
git add src/client/Main.ts src/client/GameStatsModal.ts tests/GameHistoryRoute.test.ts && git commit -m "feat(history): /history route and stats back-navigation"
```

---

## Task 5: Add a navigation entry

**Files:**

- Modify: `index.html`, `resources/lang/en.json` (only if the nav needs a distinct label)

- [ ] **Step 1: Find the nav pattern**

```bash
grep -n "nav-menu-item" index.html | head -10
```

- [ ] **Step 2: Add the entry**

Copy the markup of an adjacent `nav-menu-item` exactly — same classes, same icon-and-label structure — changing only `data-page="page-history"` and the label. Place it next to the account/leaderboard entries. The delegated handler at `src/client/Navigation.ts:82` needs no change.

Reuse `game_history.page_title` as the label unless the nav needs something shorter; if it does, add `game_history.nav_label` in alphabetical order and re-run `npx vitest tests/EnJsonSorted.test.ts --run`.

- [ ] **Step 3: Verify in the running app**

```bash
npm run dev
```

Then use the `run-openfront` skill to drive the browser. Confirm all four:

1. The nav entry opens the history page.
2. Visiting `/history` directly opens it.
3. Signed out, the sign-in notice shows instead of an empty list.
4. Signed in, metrics render above the list and update when a filter is changed.

- [ ] **Step 4: Commit**

```bash
git add index.html resources/lang/en.json && git commit -m "feat(history): navigation entry for the history page"
```

---

## Task 6: Surface the unused per-game KPIs

Everything below is already archived and currently discarded.

**Files:**

- Modify: `src/client/components/baseComponents/ranking/GameInfoRanking.ts`
- Test: `tests/GameInfoRanking.test.ts`

**Interfaces:**

- Consumes: `PlayerStats` from `src/core/StatsSchemas.ts`; index constants `ATTACK_INDEX_SENT`, `UNIT_INDEX_BUILT` (confirm the exact exported names in Step 1).
- Produces: `PlayerInfo` gains `finalTiles: number`, `buildingsBuilt: number`, `attacksSent: number`, `betrayals: number`. `RankType` gains `FinalTiles`, `BuildingsBuilt`, `AttacksSent`, `Betrayals`, each with a `RANK_TYPE_LABEL_KEYS` entry.

- [ ] **Step 1: Confirm the index constant names**

```bash
grep -n "export const ATTACK_INDEX\|export const UNIT_INDEX" src/core/StatsSchemas.ts
```

Use the exact names printed. The plan below assumes `ATTACK_INDEX_SENT` and `UNIT_INDEX_BUILT`.

- [ ] **Step 2: Write the failing tests**

Append to `tests/GameInfoRanking.test.ts`, inside the existing `describe("Ranking class", ...)` block. Reuse the file's existing `makeSession` helper — read the top of the file first to match its exact shape:

```ts
it("ranks by final tiles", () => {
  const session = makeSession({
    info: {
      ...makeSession().info,
      players: [
        {
          clientID: "p1",
          username: "Alice",
          clanTag: null,
          stats: { conquests: [1n], finalTiles: 500n },
        },
        {
          clientID: "p2",
          username: "Bob",
          clanTag: null,
          stats: { conquests: [1n], finalTiles: 1200n },
        },
      ],
    },
  } as Partial<AnalyticsRecord>);
  const ranking = new Ranking(session);
  const sorted = ranking.sortedBy(RankType.FinalTiles);
  expect(sorted[0].username).toBe("Bob");
  expect(ranking.score(sorted[0], RankType.FinalTiles)).toBe(1200);
});

it("sums buildings built across all building types", () => {
  const session = makeSession({
    info: {
      ...makeSession().info,
      players: [
        {
          clientID: "p1",
          username: "Alice",
          clanTag: null,
          stats: {
            conquests: [1n],
            units: { city: [3n, 0n, 0n, 0n], port: [2n, 0n, 0n, 1n] },
          },
        },
      ],
    },
  } as Partial<AnalyticsRecord>);
  const ranking = new Ranking(session);
  const alice = ranking.allPlayers[0];
  expect(ranking.score(alice, RankType.BuildingsBuilt)).toBe(5);
});

it("scores missing stat fields as zero without throwing", () => {
  const session = makeSession({
    info: {
      ...makeSession().info,
      players: [
        {
          clientID: "p1",
          username: "Alice",
          clanTag: null,
          stats: { conquests: [1n] },
        },
      ],
    },
  } as Partial<AnalyticsRecord>);
  const ranking = new Ranking(session);
  const alice = ranking.allPlayers[0];
  expect(ranking.score(alice, RankType.FinalTiles)).toBe(0);
  expect(ranking.score(alice, RankType.BuildingsBuilt)).toBe(0);
  expect(ranking.score(alice, RankType.AttacksSent)).toBe(0);
  expect(ranking.score(alice, RankType.Betrayals)).toBe(0);
});

it("gives every rank type a label key", () => {
  for (const type of Object.values(RankType)) {
    expect(RANK_TYPE_LABEL_KEYS[type]).toBeTruthy();
  }
});
```

Add `RANK_TYPE_LABEL_KEYS` to the file's existing import from `GameInfoRanking`.

- [ ] **Step 3: Run to verify failure**

```bash
npx vitest tests/GameInfoRanking.test.ts --run
```

Expected: FAIL — `RankType.FinalTiles` is undefined.

- [ ] **Step 4: Extend the ranking**

In `src/client/components/baseComponents/ranking/GameInfoRanking.ts`:

Add to the `RankType` enum:

```ts
  FinalTiles = "FinalTiles",
  BuildingsBuilt = "BuildingsBuilt",
  AttacksSent = "AttacksSent",
  Betrayals = "Betrayals",
```

Add to `RANK_TYPE_LABEL_KEYS`:

```ts
  [RankType.FinalTiles]: "game_info_modal.final_tiles",
  [RankType.BuildingsBuilt]: "game_info_modal.buildings_built",
  [RankType.AttacksSent]: "game_info_modal.attacks_sent",
  [RankType.Betrayals]: "game_info_modal.betrayals",
```

Add to the `PlayerInfo` interface:

```ts
finalTiles: number;
buildingsBuilt: number;
attacksSent: number;
betrayals: number;
```

In `summarizePlayers`, inside the object literal assigned to `players[player.clientID]`:

```ts
        finalTiles: Number(stats.finalTiles ?? 0n),
        // Buildings are per-type index arrays; BUILT is one slot of each.
        buildingsBuilt: Object.values(stats.units ?? {}).reduce(
          (sum, counts) => sum + Number(counts?.[UNIT_INDEX_BUILT] ?? 0n),
          0,
        ),
        attacksSent: Number(stats.attacks?.[ATTACK_INDEX_SENT] ?? 0n),
        betrayals: Number(stats.betrayals ?? 0n),
```

Add the two index constants to the existing import from `../../../../core/StatsSchemas`.

Add to the `getScore` switch:

```ts
      case RankType.FinalTiles:
        return player.finalTiles;
      case RankType.BuildingsBuilt:
        return player.buildingsBuilt;
      case RankType.AttacksSent:
        return player.attacksSent;
      case RankType.Betrayals:
        return player.betrayals;
```

- [ ] **Step 5: Add the label keys**

In `resources/lang/en.json`, add to the existing `game_info_modal` object, in alphabetical order within it:

```json
    "attacks_sent": "Attacks launched",
    "betrayals": "Betrayals",
    "buildings_built": "Buildings built",
    "final_tiles": "Final territory",
```

- [ ] **Step 6: Run the tests**

```bash
npx vitest tests/GameInfoRanking.test.ts --run && npx vitest tests/EnJsonSorted.test.ts --run
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run format
```

```bash
git add src/client/components/baseComponents/ranking/GameInfoRanking.ts tests/GameInfoRanking.test.ts resources/lang/en.json && git commit -m "feat(stats): rank by territory, buildings, attacks and betrayals"
```

---

## Task 7: Render the new rank types in the player row

`PlayerRow` switches on `rankType` to choose a presentation. New types need a branch or they render blank.

**Files:**

- Modify: `src/client/components/baseComponents/ranking/PlayerRow.ts`

- [ ] **Step 1: Read the existing presentation switch**

```bash
sed -n '140,180p' src/client/components/baseComponents/ranking/PlayerRow.ts
```

Note which types use a progress bar, which use a plain count, and what the fallback is.

- [ ] **Step 2: Add branches for the four new types**

All four are plain counts, so route them to the same presentation the bomb-count types use. Match the file's existing formatting helper — do not introduce a new number formatter.

Territory (`FinalTiles`) can be large; if the file has a compact/abbreviated formatter already in use for gold, reuse it for `FinalTiles` and leave the other three as plain integers.

- [ ] **Step 3: Verify a value renders, not a blank**

```bash
npm run dev
```

Open a finished game's stats (`#modal=stats&gameID=<id>`), switch the ranking selector to each of the four new modes, and confirm a number appears for every player.

- [ ] **Step 4: Commit**

```bash
npm run lint && npm run format
```

```bash
git add src/client/components/baseComponents/ranking/PlayerRow.ts && git commit -m "feat(stats): render the new rank types in the player row"
```

---

## Task 8: Handle the version-mismatch case honestly

The most common real-world failure: every deploy invalidates existing replays.

**Files:**

- Modify: `src/client/JoinLobbyModal.ts`, `resources/lang/en.json`

- [ ] **Step 1: Find how `version_mismatch` currently surfaces**

```bash
grep -n "version_mismatch" src/client/JoinLobbyModal.ts
```

Both call sites (~line 400 and ~1033) switch on the result. Read what each does today.

- [ ] **Step 2: Check whether a message already exists**

```bash
grep -n "version_mismatch\|outdated\|mismatch" resources/lang/en.json
```

If a suitable key exists, use it and skip Step 3.

- [ ] **Step 3: Add a message if none exists**

Add to the relevant existing object in `resources/lang/en.json` (alphabetically):

```json
    "replay_version_mismatch": "This match was recorded on an earlier version of the game and can no longer be replayed.",
```

- [ ] **Step 4: Show it**

At both `version_mismatch` branches, display that message using whatever mechanism the surrounding code already uses for user-facing errors. Do not add a new toast or alert system.

- [ ] **Step 5: Verify**

```bash
npx vitest tests/EnJsonSorted.test.ts --run && npx tsc --noEmit && npm run lint
```

- [ ] **Step 6: Commit**

```bash
npm run format
```

```bash
git add src/client/JoinLobbyModal.ts resources/lang/en.json && git commit -m "fix(replay): explain version mismatch instead of a generic failure"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run the whole suite**

```bash
npm test
```

Expected: PASS. Any failure here is a regression from Tasks 1-8 — fix it before continuing; do not skip a test.

- [ ] **Step 2: Lint and format clean**

```bash
npm run lint && npm run format
```

- [ ] **Step 3: Production build**

```bash
npm run build-prod
```

Expected: success. This is the check that catches a missing component import — the dev server is more forgiving.

- [ ] **Step 4: End-to-end walkthrough**

```bash
npm run dev
```

Using the `run-openfront` skill, verify in order:

1. `/history` loads directly; `/w1/history` also loads.
2. Signed out → sign-in notice, no empty list.
3. Signed in → metrics header above the list.
4. Changing a filter updates both list and metrics together.
5. Scrolling loads more games and the metrics grow accordingly.
6. The stats button opens the game detail; its back button returns to `/history`, not the account modal.
7. The detail view's new rank modes show numbers for every player.
8. The replay button starts a replay for a current-version game.
9. An older game shows the version-mismatch message rather than a generic error.

- [ ] **Step 5: Report honestly**

Write up what was verified and what was not. If any step above could not be checked (for example, no archived game from a previous version was available to test step 9), say so plainly rather than implying full coverage.

---

## Self-Review

**Spec coverage**

| Spec requirement                                       | Task                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `/history` path route, worker prefix                   | 4                                                                                |
| Hash route registration                                | 4                                                                                |
| Page mounted as `page-content`, nav entry              | 3, 5                                                                             |
| Reuse list component, wire `view-game` / `view-stats`  | 3                                                                                |
| Metrics: games, win rate, avg duration, best map, form | 1, 2                                                                             |
| Incomplete ≠ defeat                                    | 1 (test)                                                                         |
| Scope label                                            | 2                                                                                |
| Best map min. 3 games                                  | 1 (test + constant)                                                              |
| Metrics track the filtered set                         | 3 (recompute from `history-updated`)                                             |
| Per-game KPIs: tiles, buildings, attacks, betrayals    | 6, 7                                                                             |
| Missing fields render as "—"                           | 6 (test) — see note below                                                        |
| Singleplayer via API filter                            | none needed — the `type=singleplayer` tab already exists                         |
| Not-signed-in state                                    | 3                                                                                |
| Version mismatch message                               | 8                                                                                |
| Load failure                                           | none needed — the list already retries; the header renders nothing at zero games |
| i18n via `translateText` + `en.json` only              | 2, 5, 6, 8                                                                       |

**Note on "—" vs 0:** Task 6 scores missing fields as `0` for _sorting_ (a sort comparator needs a number), while the spec's "—" rule governs _display_. Task 7 owns the display side. When implementing Task 7, render `"—"` where the underlying stat field is absent and `0` where it is genuinely zero — if `PlayerRow` cannot distinguish the two from `PlayerInfo` alone, add an optional `hasStat` flag rather than showing a misleading `0`.

**Placeholder scan:** No TBDs. Every code step carries real code. Tasks 5, 7 and 8 direct the implementer to read existing patterns first rather than prescribing markup blind — that is deliberate, since guessing at unread markup would be worse than a short lookup, and each such step names the exact command and the decision to make.

**Type consistency:** `computeHistoryMetrics` / `HistoryMetrics` / `BEST_MAP_MIN_GAMES` (Task 1) are consumed unchanged in Task 2. `PlayerGameHistoryCache` matches the exported type. `openFromHistory` (Task 4) matches the call in Task 3. `returnToGames()` on `<game-history-page>` (Task 3) matches Task 4's back branch and mirrors the existing `AccountModal.returnToGames()` name. The four new `RankType` members are spelled identically in Tasks 6 and 7.

**Unverified assumptions, flagged for the implementer:** `translateText` interpolation (Task 2 Step 4), `window.showPage` typing and `UserMeResponse` export path (Task 3 Step 3), the exact index constant names (Task 6 Step 1), and whether `Main.ts` is importable in a test without DOM side effects (Task 4 Step 2). Each has a stated fallback.
