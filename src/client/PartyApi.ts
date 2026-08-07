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
 * One message to the whole party, delivered over the friend-event streams.
 * Fire-and-forget from the caller's perspective — the echo arrives on the
 * sender's own stream like everyone else's.
 */
export async function sendPartyChat(body: string): Promise<boolean> {
  try {
    const res = await partyFetch("/parties/@me/chat", {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return res.ok;
  } catch (err) {
    console.warn("sendPartyChat: request failed", err);
    return false;
  }
}

export interface PartyFit {
  fits: boolean;
  partySize: number;
  /** Seats per team, or null when the lobby's team size is not fixed. */
  seats: number | null;
}

/**
 * Asks whether the caller's party can be seated together in a lobby of the
 * given shape.
 *
 * Fails open: a player not in a party, a signed-out visitor and a backend
 * that is unreachable all resolve to `fits: true`. Blocking someone from a
 * lobby because a side request failed would be worse than the mis-seating
 * this is meant to prevent.
 */
export async function fetchPartyFit(
  teamCount: number | string,
): Promise<PartyFit> {
  const open: PartyFit = { fits: true, partySize: 0, seats: null };
  try {
    const res = await partyFetch(
      `/parties/@me/fit?teamCount=${encodeURIComponent(String(teamCount))}`,
    );
    if (!res.ok) return open;
    const body = (await res.json()) as Partial<PartyFit>;
    if (typeof body.fits !== "boolean") return open;
    return {
      fits: body.fits,
      partySize: typeof body.partySize === "number" ? body.partySize : 0,
      seats: typeof body.seats === "number" ? body.seats : null,
    };
  } catch {
    return open;
  }
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

/**
 * Live party updates from GET /parties/@me/events (Server-Sent Events).
 *
 * NOT built on `EventSource`, deliberately. The backend's requireAuth
 * (backend/src/plugins/auth.ts) reads the access token from the
 * `Authorization: Bearer` header ONLY — it never looks at the session cookie,
 * and it accepts no token query parameter. Verified against the running
 * backend: a cookie-only request (which is exactly what
 * `new EventSource(url, { withCredentials: true })` sends) answers
 * `401 {"error":"Missing bearer token"}`, and `?token=<jwt>` answers 401 too.
 * Native EventSource cannot set request headers, so it simply cannot
 * authenticate against this route.
 *
 * fetch + ReadableStream can send the header, so it reuses getAuthHeader()
 * like every other call here — the same session, no second auth path, and no
 * token in a URL where it would leak into access logs and Referer headers.
 *
 * The trade-off versus EventSource is that automatic reconnection is ours to
 * implement; `connectPartyStream` below does that, and the caller's teardown
 * stops it.
 */

/** Server-driven party state. `party: null` means "no longer in a party". */
export type PartyStreamEvent = { party: Party | null };

export interface PartyStreamHandlers {
  /** A `party` event arrived. Fires for the stream's initial state too. */
  onEvent: (event: PartyStreamEvent) => void;
  /**
   * The stream could not be established or died and is not being retried.
   * The caller is expected to fall back to polling.
   */
  onFailure: () => void;
  /** The stream is live. Lets the caller stand its poll down. */
  onOpen?: () => void;
  /**
   * The connection dropped and a retry is pending. Distinct from onFailure:
   * the stream is coming back, but it is NOT delivering right now, so the
   * caller should poll in the meantime rather than sit on stale state.
   */
  onDisconnect?: () => void;
}

/** Handle returned by connectPartyStream. `close()` is idempotent. */
export interface PartyStreamHandle {
  close: () => void;
}

/** Retry backoff, capped. Mirrors what EventSource would do for us. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15_000;

/**
 * Treat the connection as dead if nothing arrives for this long.
 *
 * The server heartbeats every 25s (HEARTBEAT_MS in
 * backend/src/routes/partyEvents.ts), so silence well past that means the
 * stream is gone. This is not belt-and-braces: when the server process dies
 * abruptly the browser may leave the pending read hanging forever rather than
 * resolving `done` or rejecting, so without this watchdog a dropped stream is
 * never noticed and the roster silently freezes. Verified against a killed
 * backend, where the read loop alone did not observe the disconnect.
 */
const STALL_TIMEOUT_MS = 60_000;

/**
 * Parses an SSE frame ("event: x\ndata: y") into name + raw data. Comment
 * lines (": keepalive") carry no event and are skipped by the caller.
 */
function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not data.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/**
 * Opens the live party stream and keeps it open until `close()` is called.
 *
 * Reconnects on a dropped connection with backoff. A 401 is treated as fatal
 * (the viewer is signed out — retrying cannot fix it) and reports failure so
 * the caller can fall back rather than spin.
 *
 * Exactly one read loop is ever in flight per handle, so a reconnect can never
 * produce two concurrent subscriptions delivering duplicate events.
 */
export function connectPartyStream(
  handlers: PartyStreamHandlers,
): PartyStreamHandle {
  let closed = false;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const close = () => {
    if (closed) return;
    closed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // Aborting the fetch is what actually drops the TCP connection, which is
    // what makes the backend's 'close' handler run and release its Redis
    // listener. Without this the stream would outlive the modal.
    controller?.abort();
    controller = null;
  };

  const scheduleRetry = () => {
    if (closed) return;
    // Tell the caller it is momentarily blind so it can poll while we retry.
    handlers.onDisconnect?.();
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    attempt++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void run();
    }, delay);
  };

  const run = async (): Promise<void> => {
    if (closed) return;
    const ac = new AbortController();
    controller = ac;

    try {
      const authHeader = await getAuthHeader();
      // No session: the route would 401 and retrying would not help.
      if (authHeader === "") {
        if (!closed) handlers.onFailure();
        return;
      }
      if (closed) return;

      const res = await fetch(`${getApiBase()}/parties/@me/events`, {
        headers: { Accept: "text/event-stream", Authorization: authHeader },
        credentials: "include",
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        // 401 (signed out) and 404 (older backend without the route) are both
        // permanent for this session — fall back to polling instead of
        // hammering an endpoint that will keep refusing.
        if (!closed) handlers.onFailure();
        return;
      }

      // Connected: reset backoff so a later blip retries promptly.
      attempt = 0;
      if (!closed) handlers.onOpen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Aborting on stall is what surfaces a silently-dead connection: it
      // rejects the pending read, which lands in the catch below and retries.
      let stall: ReturnType<typeof setTimeout> | null = null;
      const armStall = () => {
        if (stall) clearTimeout(stall);
        stall = setTimeout(() => {
          if (!closed) ac.abort();
        }, STALL_TIMEOUT_MS);
      };
      armStall();

      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          // Any traffic, heartbeat included, proves the peer is alive.
          armStall();
          buffer += decoder.decode(value, { stream: true });

          // Frames are separated by a blank line. Keep the trailing partial
          // frame in the buffer until its terminator arrives.
          let split: number;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const parsed = parseSseFrame(frame);
            if (!parsed || parsed.event !== "party") continue;
            try {
              const json = JSON.parse(parsed.data);
              const validated = PartyResponseSchema.safeParse(json);
              if (!validated.success) {
                console.warn("partyStream: zod failed", validated.error);
                continue;
              }
              if (!closed) handlers.onEvent({ party: validated.data.party });
            } catch (err) {
              console.warn("partyStream: bad frame", err);
            }
          }
        }
      } finally {
        if (stall) clearTimeout(stall);
      }

      // The server ended the stream (restart, deploy). Reconnect.
      if (!closed) scheduleRetry();
    } catch (err) {
      // `closed` distinguishes the two kinds of abort: close() sets it and
      // must not retry, while the stall watchdog aborts without setting it and
      // must reconnect.
      if (closed) return;
      console.warn("partyStream: connection failed", err);
      scheduleRetry();
    } finally {
      if (controller === ac) controller = null;
    }
  };

  void run();

  return { close };
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
