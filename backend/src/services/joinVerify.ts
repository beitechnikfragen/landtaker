import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { bans, users } from "../db/schema.ts";

/**
 * `POST /join_verify` — the screening call the game server makes for EVERY
 * player entering a match (src/server/JoinVerify.ts, `verifyJoin`).
 *
 * The response shape is not ours to choose. The game parses it with a
 * discriminated union on `status` and treats anything else — a non-200, a
 * shape it cannot parse, a timeout — as `{status:"error"}`, which it handles
 * by failing open with the locally censored name. So a 404 (today) and a
 * malformed 200 land in the same bucket; the only thing a wrong shape costs us
 * is the ban enforcement below silently never happening.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WE ACTUALLY CHECK, AND WHAT WE DELIBERATELY DO NOT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. Turnstile / captcha — NOT VERIFIED. We have TURNSTILE_SITE_KEY in dev
 *    (Cloudflare's always-passes test key 1x00000000000000000000AA) but no
 *    secret key is configured anywhere in this repo, and siteverify requires
 *    one. There is no honest way to validate the token, so we do not pretend
 *    to: a presented token is accepted unexamined and the join is allowed.
 *    Rejecting tokens we cannot check would lock out every legitimate player;
 *    claiming to have checked them would be a lie that hides the gap. When a
 *    TURNSTILE_SECRET_KEY exists, the check belongs exactly here, in
 *    `verifyTurnstile` below.
 *
 * 2. Ban enforcement — DONE. This is the one real check we can make today,
 *    and the reason this endpoint is worth more than a 404. See
 *    `findActiveBanByDisplayName`.
 *
 * 3. Username moderation — NOT DONE. Upstream runs an LLM check on names it
 *    has not seen before and returns a deterministic shadow name for a banned
 *    one. We have no such model and no name blocklist here. We therefore
 *    return the username EXACTLY as it was given to us. That is not a silent
 *    hole: the game server already ran its local censor (src/server/Censor.ts)
 *    before calling us, and it uses that same locally-screened name whenever
 *    we answer "error". Echoing the input back preserves that behaviour
 *    instead of overriding a real check with a fake one.
 *
 * 4. Per-IP rate limiting — NOT DONE. Redis is available, but a counter here
 *    would be the wrong shape: joins arrive in legitimate bursts (a whole
 *    lobby reconnecting at game start, an entire household or a school behind
 *    one NAT address) and the `ip` we receive is whatever the game server
 *    resolved behind its proxy chain. A limit tight enough to stop abuse
 *    would refuse real players in exactly the scenarios that look most like
 *    abuse, and this endpoint has no way to say "slow down" — only "you may
 *    not play". Rate limiting belongs at the edge/proxy, not in the join
 *    verdict. Skipped on purpose rather than added because it was easy.
 *
 * The clan tag IS uppercased, which is the one identity normalisation the
 * game documents as ours to do ("a surviving tag uppercased").
 */

/**
 * The verdict, in the game's own vocabulary. Deliberately NOT the
 * `{status:"error"}` arm of the game's `JoinVerifyResponse`: that arm is what
 * the game synthesises locally when we fail it. Nothing we ever put on the
 * wire is allowed to be "error" — see the fail-open note on `verifyJoin`.
 */
export type JoinVerdict =
  | { status: "approved"; username: string; clanTag: string | null }
  | { status: "rejected"; reason: string };

export interface JoinVerifyInput {
  ip: string | null;
  token: string | null;
  username: string;
  clanTag: string | null;
}

/**
 * Clan tags render in a fixed-width slot next to the name, so an unbounded
 * one would spill across the UI. The game itself caps at 5; we clamp rather
 * than reject, because a too-long tag is a cosmetic problem and refusing the
 * join over it would be wildly disproportionate.
 */
const MAX_CLAN_TAG_LENGTH = 5;

export function normalizeClanTag(clanTag: string | null): string | null {
  if (clanTag === null) return null;
  const trimmed = clanTag.trim();
  if (trimmed.length === 0) return null;
  // "a surviving tag uppercased" — the game's words for what it expects back.
  return trimmed.slice(0, MAX_CLAN_TAG_LENGTH).toUpperCase();
}

/**
 * Turnstile verification, deliberately unimplemented.
 *
 * Returns `null` for "no verdict" rather than `true` for "passed", so that a
 * future implementation cannot be mistaken for the current no-op by a reader,
 * and so the caller has to decide explicitly what an absent verdict means.
 *
 * SECURITY: a null token means the game server is re-verifying an
 * already-admitted reconnect whose single-use token is spent, and it expects
 * us to skip siteverify entirely (see planJoinVerify in the game). Once a
 * secret key exists, that null case must STILL skip — only a non-null token
 * may be redeemed, and only once.
 */
export function verifyTurnstile(_token: string | null): null {
  // No TURNSTILE_SECRET_KEY is configured for this backend, and siteverify is
  // impossible without one. Returning "no verdict" is the honest answer; the
  // caller allows the join and logs nothing alarming, because an unverifiable
  // token is our gap, not the player's fault.
  return null;
}

/**
 * Resolves the account behind a display name and returns its active ban, if
 * any.
 *
 * The request body carries no user id — only `{ip, token, username, clanTag}`
 * — so the display name is the only handle we have on an identity. That makes
 * the lookup deliberately conservative:
 *
 *   - "base.1234" matches exactly one account (base + discriminator) and is
 *     unforgeable by another player, because the discriminator is assigned.
 *   - a bare "base" is only trusted when it resolves to exactly ONE account.
 *     Entitled holders render without a discriminator but still have one
 *     stored, so a bare name can be ambiguous — and refusing a join on an
 *     ambiguous match would let anyone get a stranger banned from matches by
 *     typing their name. Ambiguity therefore means "no ban found".
 *
 * A player who is not signed in, or whose typed name matches no account, is
 * simply not ban-checkable here; the game gates account-only features
 * elsewhere.
 *
 * This mirrors `findActiveBan` in services/users.ts, which is a different
 * function with a different key (userId) and belongs to another owner. The
 * predicate — not lifted, and either permanent or not yet expired — is
 * restated rather than imported so neither file has to change for the other.
 */
export async function findActiveBanByDisplayName(
  displayName: string,
): Promise<{ category: string; reason: string | null } | null> {
  const name = displayName.trim();
  if (name.length === 0) return null;

  const activeBanPredicate = and(
    isNull(bans.liftedAt),
    or(isNull(bans.expiresAt), gt(bans.expiresAt, new Date())),
  );

  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const rows = await db
      .select({ category: bans.category, reason: bans.reason })
      .from(bans)
      .innerJoin(users, eq(users.id, bans.userId))
      .where(
        and(
          eq(users.usernameBase, name.slice(0, dot)),
          eq(users.usernameDiscriminator, name.slice(dot + 1)),
          activeBanPredicate,
        ),
      )
      .limit(1);
    if (rows[0]) return rows[0];
    // A dotted name that resolved to no ban is a complete answer: it either
    // named a clean account or named nobody. Do not fall through to the bare
    // match, which would strip the discriminator and could hit someone else.
    return null;
  }

  // Bare name: require a unique account before trusting it (limit 2 so a
  // second hit is detectable).
  const candidates = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameBase, name))
    .limit(2);
  if (candidates.length !== 1 || !candidates[0]) return null;

  const rows = await db
    .select({ category: bans.category, reason: bans.reason })
    .from(bans)
    .where(and(eq(bans.userId, candidates[0].id), activeBanPredicate))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The reason string handed back on a ban. It reaches the player only as a
 * websocket close reason, so it stays short and free of anything that would
 * confirm account details to someone probing other people's names.
 */
export function banRejectionReason(category: string): string {
  return `banned: ${category}`;
}

/**
 * How long the ban lookup gets before we give up and approve.
 *
 * The game aborts the whole call at 5s (AbortSignal.timeout(5000) in
 * src/server/JoinVerify.ts), so anything slower than that is not merely late,
 * it is useless — the player has already been admitted by the game's own
 * fail-open. Budgeting well under that means WE decide the fail-open, quickly
 * and with a log line, instead of leaving the game to time out and guess.
 *
 * This matters more than it looks: an unreachable Postgres does not reject a
 * query, it HANGS. Without this bound the request would sit open for the full
 * client timeout on every single join, and a database outage would turn into
 * thousands of stuck sockets on top of the outage itself.
 */
export const BAN_LOOKUP_TIMEOUT_MS = 2000;

/** Rejects with a timeout error if `work` outlives `ms`. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, rejectRace) => {
        timer = setTimeout(
          () => rejectRace(new Error(`timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs the verdict for one joining player.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * FAIL-OPEN. This is the load-bearing decision in this file.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Every player entering every match passes through here. If this function
 * throws — Postgres is down, a connection pool is exhausted, a migration is
 * mid-flight — we let the join through with the name we were given, and we
 * log loudly at the route layer. We do NOT reject, and we do NOT return a 500
 * hoping the game does something sensible.
 *
 * The reasoning:
 *
 *   - Failing closed converts any backend hiccup into a total outage of the
 *     GAME. Nobody can play. The game itself is otherwise entirely
 *     independent of this backend — the simulation runs on the clients and
 *     the game server relays intents — so a database blip taking the whole
 *     game down would be an outage we invented, in a system that did not
 *     need us to be up.
 *
 *   - The blast radius of failing open is bounded and small: for the duration
 *     of the incident, a banned player might get into a match. That is a
 *     moderation miss measured in minutes, and it is recoverable — the ban is
 *     still in the database and still applies the moment we are healthy, and
 *     the game has other ban surfaces (/users/@me drives the ban screen).
 *
 *   - The game server has already decided this trade for us. Its `verifyJoin`
 *     turns every failure into `status:"error"` and its caller in Worker.ts
 *     comments "Fail open: the locally screened name stands." Failing closed
 *     here would not even produce a rejection — the game would read our 500
 *     as "error" and admit the player anyway. So a 500 buys us nothing except
 *     a misleading error log; returning a clean approval says the same thing
 *     honestly.
 *
 * The one thing we never fail open on is a bad API key: that check is at the
 * route layer, guards no player-facing behaviour, and a caller without the
 * shared secret is not the game server.
 */
export async function verifyJoin(input: JoinVerifyInput): Promise<JoinVerdict> {
  const clanTag = normalizeClanTag(input.clanTag);

  // No verdict is available (see verifyTurnstile) — the token is not a reason
  // to refuse anyone today.
  verifyTurnstile(input.token);

  // Bounded so a hung database becomes a fast approval rather than a socket
  // held open for the game's full 5s budget. The throw is caught by the route,
  // which logs it and approves — see BAN_LOOKUP_TIMEOUT_MS.
  const ban = await withTimeout(
    findActiveBanByDisplayName(input.username),
    BAN_LOOKUP_TIMEOUT_MS,
  );
  if (ban) {
    return { status: "rejected", reason: banRejectionReason(ban.category) };
  }

  // Username unchanged: we ran no moderation of our own, so we must not
  // pretend the name was screened by us (see note 3 at the top).
  return { status: "approved", username: input.username, clanTag };
}
