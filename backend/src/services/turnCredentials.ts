import type { TurnCredentialsResponse } from "@game/ApiSchemas.ts";
import { createHmac } from "node:crypto";
import { config } from "../config.ts";

/**
 * Ephemeral TURN credentials, coturn's REST API scheme
 * (https://github.com/coturn/coturn/blob/master/docs/turn-rest-api/turn-rest-api.pdf).
 *
 * The long-lived secret (TURN_STATIC_AUTH_SECRET, shared with the coturn
 * service in docker-compose.coolify.yml) never reaches the browser. Instead
 * this mints a username/credential pair that:
 *   - is only valid until `expiry` (coturn parses the leading unix timestamp
 *     out of the username itself and rejects anything past it)
 *   - is worthless to compute without the secret, but cheap to verify: coturn
 *     recomputes the same HMAC from the username it was handed
 *
 * A leaked pair is a bounded liability (a few hours of relay access for one
 * identifier), not a permanent open relay — that is the entire point of this
 * scheme over a fixed lt-cred-mech username/password.
 */

/**
 * `identifier` should be something that ties usage back to a caller (we use
 * the requester's ClientID) without being a secret itself — it is sent to
 * coturn in the clear as part of the username.
 */
export function mintTurnCredential(
  identifier: string,
): TurnCredentialsResponse | null {
  const secret = config.TURN_STATIC_AUTH_SECRET;
  const urls = parseTurnUrls(config.TURN_URLS);
  if (!secret || urls.length === 0) {
    // No self-hosted TURN configured. Not an error — the caller (route)
    // answers a STUN-only-shaped response and the client falls back
    // gracefully, exactly like a fetch failure.
    return null;
  }

  const expiry =
    Math.floor(Date.now() / 1000) + config.TURN_CREDENTIAL_TTL_SECONDS;
  // coturn's expected format: "<expiry-unix-ts>:<user-id>".
  const username = `${expiry}:${sanitizeIdentifier(identifier)}`;
  const credential = createHmac("sha1", secret)
    .update(username)
    .digest("base64");

  return { urls, username, credential };
}

function parseTurnUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/**
 * The identifier rides inside the username, which coturn logs and which this
 * response hands back to the browser verbatim. Strip the one character
 * (`:`) that would break coturn's `<expiry>:<id>` parse, and bound the
 * length so a hostile ClientID can't bloat every phone call's signaling
 * payload.
 */
function sanitizeIdentifier(identifier: string): string {
  return identifier.replaceAll(":", "_").slice(0, 128);
}
