import { ClientEnv } from "./ClientEnv";

/**
 * Cloudflare Turnstile token acquisition.
 *
 * Extracted from Main.ts so more than one flow can use it. The container is a
 * parameter because Turnstile renders a real element into it: two flows
 * sharing one container would tear down each other's widget, and the join
 * flow's prefetched token is acquired long before the user might open the
 * feedback modal.
 *
 * Note this throws instead of alert()ing (which is what the original did).
 * A modal has somewhere better to put an error message, and the join flow
 * catches it to preserve its existing behaviour.
 */

declare global {
  interface Window {
    turnstile: any;
  }
}

const SCRIPT_POLL_INTERVAL_MS = 100;
const SCRIPT_POLL_ATTEMPTS = 100; // 10s total — a slow connection, not a dead one.

export const DEFAULT_TURNSTILE_CONTAINER = "#turnstile-container";

export async function getTurnstileToken(
  containerSelector: string = DEFAULT_TURNSTILE_CONTAINER,
): Promise<{ token: string; createdAt: number }> {
  // The script tag is in index.html but loads async, so a caller early in
  // startup can arrive before it is ready.
  let attempts = 0;
  while (
    typeof window.turnstile === "undefined" &&
    attempts < SCRIPT_POLL_ATTEMPTS
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, SCRIPT_POLL_INTERVAL_MS),
    );
    attempts++;
  }

  if (typeof window.turnstile === "undefined") {
    throw new Error("Failed to load Turnstile script");
  }

  const widgetId = window.turnstile.render(containerSelector, {
    sitekey: ClientEnv.turnstileSiteKey(),
    size: "normal",
    // Stays invisible unless Cloudflare actually wants a challenge.
    appearance: "interaction-only",
    theme: "light",
  });

  return new Promise((resolve, reject) => {
    window.turnstile.execute(widgetId, {
      callback: (token: string) => {
        window.turnstile.remove(widgetId);
        resolve({ token, createdAt: Date.now() });
      },
      "error-callback": (errorCode: string) => {
        window.turnstile.remove(widgetId);
        reject(new Error(`Turnstile failed: ${errorCode}`));
      },
    });
  });
}
