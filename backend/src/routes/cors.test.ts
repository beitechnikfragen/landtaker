import { describe, expect, it } from "vitest";

/**
 * A CORS preflight that omits a method fails in the browser as an opaque
 * "NetworkError": the request never reaches Fastify, so nothing is logged
 * server-side and the only clue is in the browser console. That is exactly how
 * the admin panel's PATCH broke in production — @fastify/cors defaults to
 * GET/HEAD/POST, and PATCH/PUT are used by only one route each.
 *
 * Asserting on the preflight rather than the route means adding a verb without
 * allowing it fails here instead of after a deploy.
 */

/** Methods any route in this backend answers on. */
const USED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

async function preflight(method: string) {
  // Imported lazily and per-test so CORS_ORIGIN is read after it is set.
  const { buildApp } = await import("../app.ts");
  const app = await buildApp();
  try {
    return await app.inject({
      method: "OPTIONS",
      url: "/admin/users/some-id",
      headers: {
        origin: "http://localhost:9000",
        "access-control-request-method": method,
        "access-control-request-headers": "content-type,authorization",
      },
    });
  } finally {
    await app.close();
  }
}

describe("CORS preflight", () => {
  for (const method of USED_METHODS) {
    it(`allows ${method}`, async () => {
      const res = await preflight(method);
      expect(res.statusCode).toBeLessThan(400);
      expect(res.headers["access-control-allow-methods"]).toContain(method);
    });
  }

  it("still sends credentials, which the refresh cookie depends on", async () => {
    const res = await preflight("PATCH");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
