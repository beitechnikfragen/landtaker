/**
 * What the player was doing when they pressed the feedback button.
 *
 * A bug report that says "it broke" is nearly worthless; the same report with
 * a game id, a map and a tick number is something you can actually chase. But
 * the feedback modal has no business reaching into the game runner to fetch
 * that — it would couple a UI panel to the simulation and drag the whole game
 * into the modal's import graph.
 *
 * So the flow inverts: whoever starts and stops a match writes a small record
 * here, and the modal reads it. Nothing in this module imports the game.
 *
 * Deliberately NOT recorded: anything per-tick or unbounded. This is a
 * snapshot of identity and position in a match, not a replay — see the spec's
 * note on why a bug report must not quietly ship a match transcript.
 */

export interface ActiveMatchContext {
  gameID: string;
  /** "singleplayer" | "public" | "private" — where the match came from. */
  source?: string;
  map?: string;
  gameMode?: string;
  difficulty?: string;
  /** True when the player is watching rather than playing. */
  spectating?: boolean;
  /** Human players at start. Bots are not counted; they are config, not people. */
  humanPlayers?: number;
  /** Wall-clock ms since the match started, filled in at read time. */
  startedAt?: number;
}

let active: ActiveMatchContext | null = null;

/** Called when a match starts. Replaces any previous record. */
export function setActiveMatch(context: ActiveMatchContext): void {
  active = { ...context, startedAt: Date.now() };
}

/**
 * Called when a match ends or the player leaves.
 *
 * Clearing matters: a stale match id attached to a menu report is worse than
 * no match id, because it sends whoever reads it chasing the wrong game.
 */
export function clearActiveMatch(): void {
  active = null;
}

/**
 * The current match, with elapsed time resolved, or null in the menu.
 *
 * `startedAt` is converted to `elapsedSeconds` here rather than stored that
 * way, because the useful question is "how far into the match was this?", and
 * that answer changes with every second the modal sits open.
 */
export function getActiveMatch(): Record<string, unknown> | null {
  if (active === null) return null;

  const { startedAt, ...rest } = active;
  const context: Record<string, unknown> = { ...rest };

  if (startedAt !== undefined) {
    context.elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  }

  // Drop keys the caller never set, so the technical-details block the user
  // reads does not fill up with "map: undefined".
  for (const key of Object.keys(context)) {
    if (context[key] === undefined) delete context[key];
  }

  return context;
}
