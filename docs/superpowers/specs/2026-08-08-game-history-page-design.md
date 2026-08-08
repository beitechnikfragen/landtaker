# Game History Page — Design

Date: 2026-08-08
Branch: `claude/match-replay-funktion-3bcd0f`

## Context

The request was "match replay function". Investigation showed replay already
exists end to end and works:

- **Recording** — every game is stored as a `GameRecord`: all turns with their
  intents, compressed (`src/core/Schemas.ts:999`). Because the simulation is
  deterministic, intents alone reproduce the match exactly.
- **Storage** — multiplayer records go to the API (`src/server/Archive.ts:15`);
  singleplayer records are uploaded from the client
  (`src/client/LocalServer.ts:321`).
- **Playback** — `LocalServer` feeds archived turns instead of live intents
  (`src/client/LocalServer.ts:132`) and verifies each turn's hash against the
  original, so simulation drift is caught.
- **Controls** — speed ×0.5 to fastest, pause, spectator view with no player
  identity (`src/client/hud/layers/ReplayPanel.ts`).
- **Entry point** — a replay button already exists per game row
  (`src/client/components/baseComponents/stats/PlayerGameHistoryView.ts:516`).
- **Per-game detail** — `GameStatsModal` + `GameInfoView` already show map,
  mode, duration and a sortable player ranking with 12 sort modes.

So this project does **not** build replay. It gives the existing history a
proper home and surfaces per-game KPI data that is already archived but never
displayed.

## Goals

1. A standalone, linkable `/history` page instead of a panel inside the account
   modal.
2. Aggregate KPIs across the loaded games.
3. Per-game detail enriched with the KPI fields that are recorded but unused.
4. Singleplayer games included via the existing API filter.

## Non-goals

- Timeline scrubbing / rewind in replays.
- Making replays survive a deploy (version pinning stays as is).
- Any new API endpoint — the API is closed source and outside this repo.
- Replacing or removing the account-modal history.

## Architecture

### Route

`/history` becomes the first non-game path route. No server change is needed:
the SPA fallback at `src/server/Master.ts:148` already serves the app shell for
any unmatched path.

Both mechanisms are wired, because the hash router is how every page in this
app is managed and skipping it would break tab/state sync:

- Register `<game-history-page>` with `ModalRouter` under `history`
  (`src/client/Main.ts:200-248`), giving `#modal=history`.
- Add a pathname branch for `/history` in `Client.handleUrl()`
  (`src/client/Main.ts:837`), next to the existing `/game/:id` regex, calling
  `showPage("page-history")`.

The path match must allow the optional worker prefix (`/w\d+/`) exactly like
the existing game regex, or the route breaks on worker hosts.

The page element is mounted in `index.html` as a `page-content` element like
every other page, so `showPage()` handles it with no special casing. A nav
entry with `data-page="page-history"` drives it via the delegated handler at
`src/client/Navigation.ts:82`.

### Page structure

```
<game-history-page>
├── history summary header   (new)
└── <player-game-history-view>   (existing, reused unchanged)
```

The list component is reused, not copied. It already emits `history-updated`
with its accumulated games (`PlayerGameHistoryView.ts:205`) — that is the
interface the header computes from. The two stay decoupled: the list knows
nothing about the metrics, the header nothing about loading.

**Critical:** the page must handle the list's `view-game` and `view-stats`
events the same way `AccountModal` does (`src/client/AccountModal.ts:500`),
otherwise the replay and stats buttons are dead on the new page.

### Metrics header

A pure function `List<PublicPlayerGame> → Metrics` in its own file next to the
component. No state, no DOM — directly testable, including the edge cases
(empty list, only incomplete games, division by zero).

| Metric       | Derivation                                 |
| ------------ | ------------------------------------------ |
| Games        | count of loaded entries                    |
| Win rate     | `victory` ÷ (`victory` + `defeat`)         |
| Avg duration | mean of `durationSeconds`                  |
| Best map     | map with highest win rate, minimum 3 games |
| Form         | last 10 games as a win/loss dot sequence   |

Two honesty rules, deliberate:

- **Incomplete games are not losses.** The list already treats `incomplete` as
  its own state (`PlayerGameHistoryView.ts:590`); folding it into defeats would
  systematically depress the win rate.
- **The scope is stated.** The header labels what it covers, e.g. "last 24
  games". Infinite scroll grows the set, so the numbers change as the user
  scrolls; without the label they read as lifetime stats that mutate
  inexplicably. "Best map" requires 3+ games for the same reason — 100% off one
  win is noise.

Metrics recompute on the filtered set, so switching to "Ranked" updates them.
Header and list always describe the same games.

### Per-game detail

`GameInfoView` is extended, not replaced. `PlayerInfo`
(`src/client/components/baseComponents/ranking/GameInfoRanking.ts:43`) gains the
recorded-but-unused fields from `PlayerStats` (`src/core/StatsSchemas.ts:106`):

- `finalTiles` — territory at game end
- `units` — buildings built (summed over all building types)
- `attacks` — sent / received
- `boats` — trade and transport
- `betrayals`
- `deathPosition` — finishing place

Matching sort modes are added to the ranking.

All `PlayerStats` fields are optional. A field missing from an older archive
renders as "—", never as 0 — "built nothing" and "not recorded" are different
claims.

### Singleplayer

Included via `fetchPublicPlayerGames`'s existing `type=singleplayer` filter,
which the UI already exposes as a tab. No new code.

Local `localStorage["game-records"]` entries are **not** used. They are stored
with `turns: []` (`src/client/ClientGameRunner.ts:806`, comment: "Not saving
turns locally"), so they are not replayable; listing them would show games the
user cannot watch. The replayable copies are uploaded to the API by
`LocalServer.archiveGame()` and come back through the normal filter.

## Error handling

| Case                           | Behaviour                                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not signed in                  | History needs a `publicId`. Show an explanatory notice, not an empty list.                                                                                                                                                                        |
| Replay unplayable after deploy | `checkArchivedGame` already returns `version_mismatch` (`src/client/JoinLobbyModal.ts:1138`). Tell the user the match was recorded on an older game version and can no longer be played back — not "error". This is the common case in daily use. |
| History load failed            | List already handles this with a retry button. Header renders no numbers rather than zeros.                                                                                                                                                       |

## Testing

- Metrics function: unit tests for win rate, incomplete-game exclusion, average
  duration, best-map threshold, form sequence, and empty/degenerate input.
- Per-game KPI extraction: missing optional fields render as "—" not 0;
  building totals sum correctly across types.
- Route parsing: `/history` and `/w1/history` both resolve.

No `src/core` changes are planned, so the core test requirement does not apply.
If that changes during implementation, tests are mandatory for those changes.

## i18n

All user-visible strings go through `translateText()` with new keys added to
`resources/lang/en.json`. No other translation file is touched (Crowdin owns
them).

## Out of scope, worth noting

The version pinning means every deploy invalidates all existing replays. That
is technically correct for a deterministic simulation — a rules change would
replay the match differently — but it makes replays short-lived in practice.
Fixing it needs versioned simulation rules and is a separate project.
