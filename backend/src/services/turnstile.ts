import { config } from "../config.ts";

/**
 * Cloudflare Turnstile verification.
 *
 * This replaces the deliberate no-op that lived in services/joinVerify.ts,
 * whose comment said the check belongs here once a TURNSTILE_SECRET_KEY
 * exists. It now does.
 *
 * The verdict is three-state on purpose. A boolean would force every caller to
 * decide what `false` means, and the two ways of not passing demand opposite
 * responses:
 *
 *   "failed"      Cloudflare looked at the token and rejected it. Refuse.
 *   "unavailable" We never got an answer — no secret, network error, timeout.
 *                 Refusing here would turn our outage into the player's
 *                 problem, so callers fail open and log.
 *
 * Callers own that policy; this module only reports what happened.
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Short because it sits in a user-facing request path. A verification that
 * takes longer than this has already cost the user more than the check is
 * worth, and the fail-open path is the safe one.
 */
const SITEVERIFY_TIMEOUT_MS = 3000;

export type TurnstileVerdict = "passed" | "failed" | "unavailable";

/**
 * The join path shares a 5s budget with a 2s ban lookup that runs after it.
 * Ban enforcement is the check that actually refuses anyone here; Turnstile
 * on this path is advisory (see the fail-open note in joinVerify.ts) and must
 * not be allowed to eat the budget the ban lookup needs to complete.
 */
export const JOIN_SITEVERIFY_TIMEOUT_MS = 1500;

export function isTurnstileConfigured(): boolean {
  return (config.TURNSTILE_SECRET_KEY ?? "").length > 0;
}

/**
 * @param token    The `cf-turnstile-response` value from the client.
 * @param remoteIp Client IP, if known. Optional per Cloudflare's API; passing
 *                 it lets Cloudflare correlate the solve with its origin.
 */
export async function verifyTurnstileToken(
  token: string | null,
  remoteIp: string | null,
  timeoutMs: number = SITEVERIFY_TIMEOUT_MS,
): Promise<TurnstileVerdict> {
  const secret = config.TURNSTILE_SECRET_KEY;
  if (secret === undefined || secret.length === 0) {
    // No secret => siteverify is impossible. "unavailable", never "failed":
    // we have no basis on which to reject anyone.
    return "unavailable";
  }

  // A configured deployment that receives no token has been given nothing to
  // check. That is a rejection, not an outage — and short-circuiting here
  // avoids a pointless round trip.
  if (token === null || token.length === 0) {
    return "failed";
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp !== null && remoteIp.length > 0) {
    body.set("remoteip", remoteIp);
  }

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    // A 5xx from Cloudflare is Cloudflare's problem. Treating it as a failed
    // solve would punish the player for someone else's outage.
    if (!response.ok) return "unavailable";

    const result = (await response.json()) as { success?: boolean };
    return result.success === true ? "passed" : "failed";
  } catch {
    // Network error, DNS failure, or the timeout above. All "we could not
    // ask", none of them "the token was bad".
    return "unavailable";
  }
}
