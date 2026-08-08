import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

/**
 * OAuth state parameter.
 *
 * The state carries the caller's return URL and must survive a round trip
 * through the provider without giving the browser a way to forge one — a
 * forged state is how an attacker completes a login into *their* account and
 * lands the victim's browser on a session they control (login CSRF).
 *
 * Rather than persisting pending logins in Postgres, the state is signed with
 * the same secret the API already holds. It is self-contained, expires on its
 * own, and needs no cleanup job.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Signing key for the state parameter. Derived from API_KEY so no new secret
 * has to be provisioned; it never leaves the server and is not a bearer token,
 * so reuse here is contained.
 */
function stateKey(): string {
  return config.API_KEY;
}

export function signState(redirectUri: string): string {
  const payload = JSON.stringify({
    r: redirectUri,
    n: randomBytes(9).toString("base64url"),
    e: Date.now() + STATE_TTL_MS,
  });
  const body = Buffer.from(payload).toString("base64url");
  const mac = createHmac("sha256", stateKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/**
 * Returns the redirect URI the login started from, or null when the state is
 * forged, tampered with, or stale. Callers must treat null as "abort the
 * login" — never as "fall back to a default".
 */
export function verifyState(state: string | undefined): string | null {
  if (!state) return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);

  const expected = createHmac("sha256", stateKey())
    .update(body)
    .digest("base64url");
  // Constant-time: a length-varying or short-circuiting compare leaks how much
  // of a guessed MAC was right.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof parsed.e !== "number" || Date.now() > parsed.e) return null;
    if (typeof parsed.r !== "string") return null;
    return parsed.r;
  } catch {
    return null;
  }
}

/**
 * Whether the client may be sent back to this URL after login.
 *
 * Compared by origin against an allowlist: an unchecked redirect_uri turns the
 * login endpoint into an open redirect that hands the freshly-set session
 * cookie to whichever site asked.
 */
export function isAllowedRedirect(target: string): boolean {
  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    return false;
  }
  return config.ALLOWED_REDIRECT_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .includes(origin);
}

/** Discord's OAuth endpoints. */
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
const DISCORD_USER = "https://discord.com/api/users/@me";

/** The profile shape /users/@me serves for a linked Discord account. */
export interface DiscordProfile {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  discriminator: string;
  email?: string | null;
}

export function discordAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID ?? "",
    redirect_uri: config.DISCORD_REDIRECT_URI,
    response_type: "code",
    // identify => id/username/avatar; email => the address, used to seed the
    // account's contact email so magic-link recovery works later.
    scope: "identify email",
    state,
    // Skip the "authorize?" screen for users who already granted access.
    prompt: "none",
  });
  return `${DISCORD_AUTHORIZE}?${params.toString()}`;
}

/**
 * Exchanges the callback code for an access token, then reads the profile.
 * Throws on any non-2xx — the caller turns that into a failed login rather
 * than a half-created account.
 */
export async function fetchDiscordProfile(
  code: string,
): Promise<DiscordProfile> {
  const tokenRes = await fetch(DISCORD_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID ?? "",
      client_secret: config.DISCORD_CLIENT_SECRET ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: config.DISCORD_REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(
      `Discord token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`,
    );
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("Discord returned no access token");

  const userRes = await fetch(DISCORD_USER, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) {
    throw new Error(`Discord profile fetch failed: ${userRes.status}`);
  }
  const user = (await userRes.json()) as Record<string, unknown>;
  if (typeof user.id !== "string") {
    throw new Error("Discord profile has no id");
  }

  return {
    id: user.id,
    username: typeof user.username === "string" ? user.username : "player",
    global_name: typeof user.global_name === "string" ? user.global_name : null,
    avatar: typeof user.avatar === "string" ? user.avatar : null,
    // Post-migration accounts report "0"; the game's avatar fallback divides by
    // it, so it must stay a numeric string.
    discriminator:
      typeof user.discriminator === "string" ? user.discriminator : "0",
    email: typeof user.email === "string" ? user.email : null,
  };
}
