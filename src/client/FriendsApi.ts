import {
  type FriendMessage,
  FriendMessageSchema,
  type FriendMessagesResponse,
  FriendMessagesResponseSchema,
  type FriendRequestsResponse,
  FriendRequestsResponseSchema,
  type FriendsListResponse,
  FriendsListResponseSchema,
  type FriendStreamEvent,
  FriendStreamEventSchema,
  type SendFriendRequestResponse,
  SendFriendRequestResponseSchema,
} from "../core/ApiSchemas";
import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";

async function friendsFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...options?.headers,
      Authorization: await getAuthHeader(),
    },
  });
}

export type FriendActionError =
  | "not_found"
  | "conflict"
  | "bad_request"
  | "request_failed";

export async function fetchFriendRequests(): Promise<
  FriendRequestsResponse | false
> {
  try {
    const res = await friendsFetch("/friends/requests");
    if (!res.ok) return false;
    const parsed = FriendRequestsResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchFriendRequests: zod failed", parsed.error);
      return false;
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchFriendRequests: request failed", err);
    return false;
  }
}

export async function fetchFriends(
  page: number,
  limit: number,
): Promise<FriendsListResponse | false> {
  try {
    const url = new URL(`${getApiBase()}/friends`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));
    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        Authorization: await getAuthHeader(),
      },
    });
    if (!res.ok) return false;
    const parsed = FriendsListResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchFriends: zod failed", parsed.error);
      return false;
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchFriends: request failed", err);
    return false;
  }
}

export async function sendFriendRequest(
  publicId: string,
): Promise<SendFriendRequestResponse | FriendActionError> {
  try {
    const res = await friendsFetch(
      `/friends/requests/${encodeURIComponent(publicId)}`,
      { method: "POST" },
    );
    if (res.status === 404) return "not_found";
    if (res.status === 409) return "conflict";
    if (res.status === 400) return "bad_request";
    if (!res.ok) return "request_failed";
    const parsed = SendFriendRequestResponseSchema.safeParse(await res.json());
    if (!parsed.success) return "request_failed";
    return parsed.data;
  } catch (err) {
    console.warn("sendFriendRequest: request failed", err);
    return "request_failed";
  }
}

export async function acceptFriendRequest(
  publicId: string,
): Promise<true | FriendActionError> {
  try {
    const res = await friendsFetch(
      `/friends/requests/${encodeURIComponent(publicId)}/accept`,
      { method: "POST" },
    );
    if (res.status === 404) return "not_found";
    if (!res.ok) return "request_failed";
    return true;
  } catch (err) {
    console.warn("acceptFriendRequest: request failed", err);
    return "request_failed";
  }
}

export async function deleteFriendRequest(
  publicId: string,
): Promise<true | FriendActionError> {
  try {
    const res = await friendsFetch(
      `/friends/requests/${encodeURIComponent(publicId)}`,
      { method: "DELETE" },
    );
    if (res.status === 404) return "not_found";
    if (!res.ok) return "request_failed";
    return true;
  } catch (err) {
    console.warn("deleteFriendRequest: request failed", err);
    return "request_failed";
  }
}

export async function removeFriend(
  publicId: string,
): Promise<true | FriendActionError> {
  try {
    const res = await friendsFetch(`/friends/${encodeURIComponent(publicId)}`, {
      method: "DELETE",
    });
    if (res.status === 404) return "not_found";
    if (!res.ok) return "request_failed";
    return true;
  } catch (err) {
    console.warn("removeFriend: request failed", err);
    return "request_failed";
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** The conversation with one friend, oldest first. */
export async function fetchMessages(
  publicId: string,
  before?: string,
): Promise<FriendMessagesResponse | false> {
  try {
    const url = new URL(
      `${getApiBase()}/friends/chat/${encodeURIComponent(publicId)}`,
    );
    if (before) url.searchParams.set("before", before);
    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        Authorization: await getAuthHeader(),
      },
    });
    if (!res.ok) return false;
    const parsed = FriendMessagesResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("fetchMessages: zod failed", parsed.error);
      return false;
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchMessages: request failed", err);
    return false;
  }
}

export async function sendChatMessage(
  publicId: string,
  body: string,
): Promise<FriendMessage | false> {
  try {
    const res = await friendsFetch(
      `/friends/chat/${encodeURIComponent(publicId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!res.ok) return false;
    const parsed = FriendMessageSchema.safeParse(await res.json());
    if (!parsed.success) return false;
    return parsed.data;
  } catch (err) {
    console.warn("sendChatMessage: request failed", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Live stream (messages + presence)
// ---------------------------------------------------------------------------

/**
 * Live friend events from GET /friends/events. Same construction as
 * connectPartyStream in PartyApi.ts — fetch + ReadableStream instead of
 * EventSource, because the backend authenticates via the Authorization header
 * only. Reconnects with backoff until close() is called.
 */
export interface FriendsStreamHandle {
  close: () => void;
}

export function connectFriendsStream(
  onEvent: (event: FriendStreamEvent) => void,
): FriendsStreamHandle {
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
    controller?.abort();
    controller = null;
  };

  const scheduleRetry = () => {
    if (closed) return;
    const delay = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt++;
    retryTimer = setTimeout(() => void run(), delay);
  };

  const run = async () => {
    if (closed) return;
    controller = new AbortController();
    try {
      const res = await fetch(`${getApiBase()}/friends/events`, {
        headers: { Authorization: await getAuthHeader() },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        scheduleRetry();
        return;
      }
      attempt = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        for (;;) {
          const frameEnd = buffer.indexOf("\n\n");
          if (frameEnd === -1) break;
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const dataLine = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const parsed = FriendStreamEventSchema.safeParse(
              JSON.parse(dataLine.slice(6)),
            );
            if (parsed.success) onEvent(parsed.data);
          } catch {
            // Malformed frame; skip rather than kill the stream.
          }
        }
      }
      scheduleRetry();
    } catch {
      scheduleRetry();
    }
  };

  void run();
  return { close };
}
