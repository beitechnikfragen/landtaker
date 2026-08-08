import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";
import { ClientEnv } from "./ClientEnv";

/**
 * Client for POST /feedback.
 *
 * Returns a discriminated result rather than throwing, because every failure
 * here has a distinct thing to tell the user — "wait 8 minutes" and "the
 * captcha did not pass" are not interchangeable, and a thrown Error would
 * flatten them into one message.
 */

export type FeedbackType = "bug" | "idea" | "other";

export interface FeedbackContext {
  clientVersion?: string;
  userAgent?: string;
  language?: string;
  screen?: string;
  instanceId?: string;
  currentPage?: string;
}

export type SubmitFeedbackResult =
  | { ok: true; id: string }
  | { ok: false; kind: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; kind: "captcha_failed" | "invalid" | "network" | "server" };

/**
 * Diagnostics attached to every report. Shown to the user in the modal before
 * sending — collecting this silently would be the wrong trade for a field
 * whose whole purpose is trust.
 *
 * Deliberately excludes game state and replay data (large, and a bug report
 * should not quietly ship a match transcript) and the IP (the backend takes
 * that from the connection, where it cannot be forged).
 */
export function collectFeedbackContext(currentPage: string): FeedbackContext {
  return {
    // The single most useful field: it turns "it broke" into a specific build.
    clientVersion: ClientEnv.gitCommit(),
    userAgent: navigator.userAgent,
    language: navigator.language,
    screen: `${window.screen.width}x${window.screen.height}`,
    // web | desktop | crazygames — very different environments.
    instanceId: ClientEnv.instanceId(),
    currentPage,
  };
}

export async function submitFeedback(input: {
  type: FeedbackType;
  message: string;
  contactEmail: string | null;
  context: FeedbackContext;
  turnstileToken: string | null;
}): Promise<SubmitFeedbackResult> {
  let response: Response;
  try {
    response = await fetch(`${getApiBase()}/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Empty for a guest; the backend's optionalAuth treats that as
        // anonymous rather than as an error.
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify({
        type: input.type,
        message: input.message,
        contactEmail: input.contactEmail,
        turnstileToken: input.turnstileToken,
        context: input.context,
      }),
    });
  } catch {
    return { ok: false, kind: "network" };
  }

  if (response.status === 201) {
    try {
      const body = (await response.json()) as { id?: string };
      return { ok: true, id: body.id ?? "" };
    } catch {
      // Stored, but we could not read the id back. Reporting failure would be
      // worse than a missing id: the user would send it again.
      return { ok: true, id: "" };
    }
  }

  if (response.status === 429) {
    // Prefer the body's value, fall back to the header, then to a sane
    // default — the user needs *some* number to act on.
    let retryAfterSeconds: number;
    try {
      const body = (await response.json()) as { retryAfterSeconds?: number };
      retryAfterSeconds = body.retryAfterSeconds ?? 0;
    } catch {
      retryAfterSeconds = 0;
    }
    if (retryAfterSeconds <= 0) {
      retryAfterSeconds = Number.parseInt(
        response.headers.get("Retry-After") ?? "600",
        10,
      );
    }
    return {
      ok: false,
      kind: "rate_limited",
      retryAfterSeconds: Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : 600,
    };
  }

  if (response.status === 403) return { ok: false, kind: "captcha_failed" };
  if (response.status === 400) return { ok: false, kind: "invalid" };
  return { ok: false, kind: "server" };
}
