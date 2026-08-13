import { and, eq } from "drizzle-orm";
import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";
import { z } from "zod";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { resolveDisplayUsername } from "./users.ts";

/**
 * Account-name rules, kept in step with AccountUsernameSchema in
 * src/core/validations/username.ts by hand.
 *
 * Not imported from there: that module pulls in the client's translateText for
 * its error strings, which would drag browser code into the backend. The
 * client's copy is for instant form feedback; this one is the one that
 * decides.
 *
 * No dots — the dot separates base from discriminator, and a base containing
 * one would render as an already-suffixed name and take the verified check
 * with it. Single spaces may separate words; edges are trimmed and repeated
 * spaces rejected so two distinct bases cannot render alike.
 */
const AccountUsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .regex(/^[a-zA-Z0-9_-]+( [a-zA-Z0-9_-]+)*$/);

/**
 * Profanity filter. The game server has its own matcher in src/server/Censor.ts
 * with extra patterns, but that file is outside the @game/* path mapping, so
 * this uses the same library and dataset directly.
 */
const profanityMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

/**
 * How long a player must wait between name changes.
 *
 * Long enough that a name is a stable handle other players can recognise in a
 * friends list or a report, short enough to correct a typo you regret.
 */
export const USERNAME_CHANGE_COOLDOWN_DAYS = 30;

/** Statuses that render the bare name and earn the verified check. */
const BARE_NAME_STATUSES = new Set(["premium", "indefinite"]);

/** How many discriminators exist for a base name: 0000-9999. */
const DISCRIMINATOR_SPACE = 10_000;

/**
 * How many random draws to try before giving up on a base name.
 *
 * Random rather than sequential so the suffix does not leak how many players
 * share a base. 40 draws only fails once the space is ~99.6% full, at which
 * point the honest answer is that the name is exhausted.
 */
const DISCRIMINATOR_ATTEMPTS = 40;

export type UsernameChangeError =
  | { code: "invalid"; reason: string }
  | { code: "profane" }
  | { code: "taken" }
  | { code: "cooldown"; retryAfterSeconds: number };

export type UsernameChangeResult =
  | {
      ok: true;
      value: {
        username: string;
        base: string;
        discriminator: string;
        usernameStatus: string;
        nextUsernameChangeAt: string | null;
      };
    }
  | { ok: false; error: UsernameChangeError };

/**
 * Validates a requested base name without touching the database.
 *
 * Split out so the rules can be tested directly: the backend suite has no
 * Postgres, and a name rule only exercised against a live database is a rule
 * that is not exercised.
 */
export function checkUsernameShape(
  rawUsername: string,
): { ok: true; base: string } | { ok: false; error: UsernameChangeError } {
  const parsed = AccountUsernameSchema.safeParse(rawUsername);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "invalid", reason: describeInvalid(parsed.error.issues) },
    };
  }
  const base = parsed.data;

  // Checked after the shape rules so an obviously malformed name gets the
  // precise reason rather than being called profane.
  if (profanityMatcher.hasMatch(base)) {
    return { ok: false, error: { code: "profane" } };
  }
  return { ok: true, base };
}

/** Seconds left on the change cooldown, or null when a change is allowed. */
export function cooldownRemaining(
  nextChangeAt: Date | null,
  now: Date,
): number | null {
  if (nextChangeAt === null || nextChangeAt <= now) return null;
  return Math.ceil((nextChangeAt.getTime() - now.getTime()) / 1000);
}

/**
 * Changes a player's account name.
 *
 * The name is stored as a base plus a four-digit discriminator, and only the
 * base is chosen: everyone renders as "Name.1234" unless their status entitles
 * them to the bare form, which is what the client turns into the verified
 * check (a name without a dot). Entitlement is granted out of band — see the
 * admin patch route — never by picking a name here.
 *
 * Keeping an entitled holder's discriminator rather than clearing it matters:
 * the bare name is a display privilege, not ownership of the row, so losing
 * the entitlement has to leave a usable "Name.1234" behind rather than a
 * collision.
 */
export async function changeUsername(
  userId: string,
  rawUsername: string,
  now: Date = new Date(),
): Promise<UsernameChangeResult> {
  const shape = checkUsernameShape(rawUsername);
  if (!shape.ok) return { ok: false, error: shape.error };
  const base = shape.base;

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) {
    return { ok: false, error: { code: "invalid", reason: "Unknown account" } };
  }

  const retryAfterSeconds = cooldownRemaining(user.nextUsernameChangeAt, now);
  if (retryAfterSeconds !== null) {
    return { ok: false, error: { code: "cooldown", retryAfterSeconds } };
  }

  // Re-picking the same base is a no-op rather than a cooldown burn: the
  // player ends up where they already were, so charging them 30 days for it
  // would be punitive.
  if (user.usernameBase === base && user.usernameDiscriminator !== null) {
    return { ok: true, value: viewOf(user) };
  }

  const entitled = BARE_NAME_STATUSES.has(user.usernameStatus ?? "");
  const discriminator = entitled
    ? (user.usernameDiscriminator ?? (await pickDiscriminator(base)))
    : await pickDiscriminator(base);

  if (discriminator === null) {
    return { ok: false, error: { code: "taken" } };
  }

  const nextChangeAt = new Date(
    now.getTime() + USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    const [row] = await db
      .update(users)
      .set({
        usernameBase: base,
        usernameDiscriminator: discriminator,
        nextUsernameChangeAt: nextChangeAt,
      })
      .where(eq(users.id, userId))
      .returning();
    if (!row) {
      return {
        ok: false,
        error: { code: "invalid", reason: "Unknown account" },
      };
    }
    return { ok: true, value: viewOf(row) };
  } catch {
    // The unique index on (base, discriminator) is the real arbiter: another
    // request can take the pair between the check above and this write, and
    // the database rejecting it is the correct outcome, not an error to log.
    return { ok: false, error: { code: "taken" } };
  }
}

/**
 * A free discriminator for a base name, or null when the space is exhausted.
 *
 * Drawn at random and verified against the table. This races with concurrent
 * signups by design; the unique index makes the loser retry rather than
 * letting two accounts render identically.
 */
async function pickDiscriminator(base: string): Promise<string | null> {
  for (let i = 0; i < DISCRIMINATOR_ATTEMPTS; i++) {
    const candidate = String(
      Math.floor(Math.random() * DISCRIMINATOR_SPACE),
    ).padStart(4, "0");
    const clash = await db.query.users.findFirst({
      where: and(
        eq(users.usernameBase, base),
        eq(users.usernameDiscriminator, candidate),
      ),
    });
    if (!clash) return candidate;
  }
  return null;
}

function viewOf(user: typeof users.$inferSelect) {
  return {
    username: resolveDisplayUsername(user) ?? "",
    base: user.usernameBase ?? "",
    discriminator: user.usernameDiscriminator ?? "",
    usernameStatus: user.usernameStatus ?? "claimed",
    nextUsernameChangeAt: user.nextUsernameChangeAt?.toISOString() ?? null,
  };
}

/** A reason the player can act on, rather than a Zod dump. */
function describeInvalid(issues: { code: string }[]): string {
  const code = issues[0]?.code;
  if (code === "too_small") return "Name is too short";
  if (code === "too_big") return "Name is too long";
  return "Use letters, numbers, spaces, _ or -";
}
