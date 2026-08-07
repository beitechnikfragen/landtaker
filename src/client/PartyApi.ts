import {
  type LeavePartyResponse,
  LeavePartyResponseSchema,
  type Party,
  type PartyErrorCode,
  PartyErrorSchema,
  PartyMutationResponseSchema,
  PartyResponseSchema,
} from "../core/PartyApiSchemas";
import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";

/**
 * Client for the party endpoints. Mirrors FriendsApi.ts: every response is
 * validated against the shared schema, and failures come back as a typed code
 * rather than an exception, so callers can render a specific message.
 */

async function partyFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      // Only when a body is actually sent: Fastify rejects a request that
      // declares application/json but carries no body ("Body cannot be empty
      // when content-type is set to 'application/json'"), which is exactly
      // what a bodyless POST like /parties/leave would do.
      ...(options?.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...options?.headers,
      Authorization: await getAuthHeader(),
    },
  });
}

/**
 * `unauthenticated` is split out from `request_failed` because it is the one
 * failure with a clear remedy — the UI can tell the player to sign in instead
 * of showing a generic error.
 */
export type PartyActionError =
  | PartyErrorCode
  | "unauthenticated"
  | "request_failed";

export type PartyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PartyActionError };

/** Reads `{ error }` off a failed response, falling back to request_failed. */
async function errorFrom(res: Response): Promise<PartyActionError> {
  // A signed-out visitor sends an empty Authorization header, so every party
  // call 401s. Report that distinctly — it is the only error the player can
  // actually act on.
  if (res.status === 401) return "unauthenticated";
  try {
    const body = (await res.json()) as { error?: unknown };
    const parsed = PartyErrorSchema.safeParse(body.error);
    if (parsed.success) return parsed.data;
  } catch {
    /* body was not JSON — fall through */
  }
  return "request_failed";
}

/**
 * The caller's current party. `null` means "signed in, but in no party" —
 * distinct from a failure, which carries an error code so the UI can tell
 * "please sign in" apart from "something broke".
 */
export async function fetchMyParty(): Promise<PartyResult<Party | null>> {
  try {
    const res = await partyFetch("/parties/@me");
    if (!res.ok) return { ok: false, error: await errorFrom(res) };
    const parsed = PartyResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchMyParty: zod failed", parsed.error);
      return { ok: false, error: "request_failed" };
    }
    return { ok: true, value: parsed.data.party };
  } catch (err) {
    console.warn("fetchMyParty: request failed", err);
    return { ok: false, error: "request_failed" };
  }
}

async function mutate(
  path: string,
  body?: unknown,
): Promise<PartyResult<Party>> {
  try {
    const res = await partyFetch(path, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) return { ok: false, error: await errorFrom(res) };
    const parsed = PartyMutationResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(`${path}: zod failed`, parsed.error);
      return { ok: false, error: "request_failed" };
    }
    return { ok: true, value: parsed.data.party };
  } catch (err) {
    console.warn(`${path}: request failed`, err);
    return { ok: false, error: "request_failed" };
  }
}

export async function createParty(options?: {
  maxMembers?: number;
  isOpen?: boolean;
}): Promise<PartyResult<Party>> {
  return mutate("/parties", options);
}

/**
 * DEVELOPMENT ONLY. Signs in without an OAuth provider by hitting the
 * backend's dev-login route, which sets the httpOnly refresh cookie.
 *
 * A reload is required afterwards and is the caller's job: the client caches
 * its JWT at startup and calls logOut() when the initial refresh finds no
 * cookie, so a session established later in the page's life is never noticed.
 *
 * The route does not exist in production (see backend/src/routes/auth.ts), so
 * this resolves to false there rather than doing anything unexpected.
 */
export async function devSignIn(username: string): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}/auth/dev-login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function joinParty(
  inviteCode: string,
): Promise<PartyResult<Party>> {
  // The server upper-cases too; doing it here keeps the optimistic UI honest.
  return mutate("/parties/join", { inviteCode: inviteCode.toUpperCase() });
}

export async function kickFromParty(
  userId: string,
): Promise<PartyResult<Party>> {
  return mutate("/parties/kick", { userId });
}

/** Leaving returns the party's fate, not a party — it may no longer exist. */
export async function leaveParty(): Promise<PartyResult<LeavePartyResponse>> {
  try {
    const res = await partyFetch("/parties/leave", { method: "POST" });
    if (!res.ok) return { ok: false, error: await errorFrom(res) };
    const parsed = LeavePartyResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("leaveParty: zod failed", parsed.error);
      return { ok: false, error: "request_failed" };
    }
    return { ok: true, value: parsed.data };
  } catch (err) {
    console.warn("leaveParty: request failed", err);
    return { ok: false, error: "request_failed" };
  }
}
