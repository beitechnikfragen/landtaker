import { db } from "../db/index.ts";
import { feedbackReports } from "../db/schema.ts";

/**
 * Storage for in-game feedback. No HTTP knowledge lives here — the route owns
 * status codes, this owns what a report is and how it is written down.
 */

export const FEEDBACK_TYPES = ["bug", "idea", "other"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** Message bounds. The floor rejects "test"/"asd"; the ceiling bounds the row. */
export const MIN_MESSAGE_LENGTH = 10;
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Reduces an address to its network prefix: /24 for IPv4, /48 for IPv6.
 *
 * This table will accumulate for years and be browsed by an admin UI, so it
 * must not become a log of exactly who reported what from where. A prefix
 * still answers the only question we actually ask of it — "are these reports
 * coming from the same place?" — which is also all the rate limiter needs.
 *
 * An unparseable value returns null rather than passing through: storing
 * something we did not recognise would defeat the guarantee entirely.
 */
export function truncateIp(ip: string | null): string | null {
  if (ip === null) return null;
  const trimmed = ip.trim();
  if (trimmed.length === 0) return null;

  // Node hands us IPv4-mapped IPv6 (::ffff:1.2.3.4) for IPv4 clients on a
  // dual-stack socket. Unwrap first, or we would keep three meaningless
  // leading groups instead of the real network.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const candidate = mapped?.[1] ?? trimmed;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(candidate);
  if (ipv4 !== null) {
    const octets = [ipv4[1], ipv4[2], ipv4[3], ipv4[4]].map((o) =>
      Number.parseInt(o!, 10),
    );
    if (octets.some((o) => o > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0`;
  }

  if (candidate.includes(":")) {
    // Handle compressed IPv6 by finding the position of "::" if it exists
    const doubleColonIndex = candidate.indexOf("::");
    let leading: string[];
    let minRequired: number;

    if (doubleColonIndex !== -1) {
      // For compressed addresses like "2001:db8::1", get everything before "::"
      const beforeDoubleColon = candidate.substring(0, doubleColonIndex);
      leading = beforeDoubleColon === "" ? [] : beforeDoubleColon.split(":");
      // A compressed address can have fewer groups
      minRequired = 1;
    } else {
      // For full addresses, just take the first 3 groups
      leading = candidate.split(":").slice(0, 3);
      // Need three real groups to form a /48. "::1" does not have them, and a
      // guessed prefix would be worse than none.
      minRequired = 3;
    }

    if (leading.length < minRequired) return null;
    if (!leading.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
    return `${leading.join(":")}::`;
  }

  return null;
}

export interface CreateFeedbackInput {
  /** Null for a guest submission. */
  userId: string | null;
  type: FeedbackType;
  message: string;
  /** Ignored by the route for logged-in users; they are contactable already. */
  contactEmail: string | null;
  context: Record<string, unknown> | null;
  /** Raw client IP. Truncated here, never stored whole. */
  ip: string | null;
}

export async function createFeedbackReport(
  input: CreateFeedbackInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(feedbackReports)
    .values({
      userId: input.userId,
      type: input.type,
      message: input.message.trim(),
      contactEmail: input.contactEmail,
      context: input.context,
      submitterIp: truncateIp(input.ip),
      // status defaults to 'new' in the schema — the admin area owns it from
      // here on.
    })
    .returning({ id: feedbackReports.id });

  // noUncheckedIndexedAccess makes this possibly-undefined. An insert with
  // RETURNING always yields a row, so this is defensive rather than expected.
  if (row === undefined) {
    throw new Error("Insert returned no row");
  }
  return row;
}
