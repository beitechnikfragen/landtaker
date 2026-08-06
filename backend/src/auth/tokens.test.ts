import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { TokenPayloadSchema } from "@game/ApiSchemas.ts";
import { base64urlToUuid } from "@game/Base64.ts";
import { config } from "../config.ts";
import { getSigningKeys, JWT_ALGORITHM } from "./keys.ts";
import {
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
} from "./tokens.ts";

/**
 * These tests assert against the GAME's own schema rather than a local copy.
 * If the game's token contract changes, this fails — which is the point.
 */
describe("access tokens", () => {
  const userId = "123e4567-e89b-12d3-a456-426614174000";

  it("produces a token the game's TokenPayloadSchema accepts", async () => {
    const { token } = await issueAccessToken({ userId });
    const { publicKey } = await getSigningKeys();

    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });

    const parsed = TokenPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    // The schema transforms sub back into a canonical UUID.
    expect(parsed.success && parsed.data.sub).toBe(userId);
  });

  it("encodes sub as base64url, not a bare UUID", async () => {
    const { token } = await issueAccessToken({ userId });
    const [, rawPayload] = token.split(".");
    const claims = JSON.parse(
      Buffer.from(rawPayload!, "base64url").toString("utf8"),
    ) as { sub: string };

    expect(claims.sub).not.toBe(userId);
    expect(base64urlToUuid(claims.sub)).toBe(userId);
  });

  it("carries role only when set", async () => {
    const withRole = await issueAccessToken({ userId, role: "admin" });
    const withoutRole = await issueAccessToken({ userId });
    const claimsOf = (token: string) =>
      JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;

    expect(claimsOf(withRole.token).role).toBe("admin");
    expect(claimsOf(withoutRole.token)).not.toHaveProperty("role");
  });

  it("rejects a token signed by a different key", async () => {
    const { token } = await issueAccessToken({ userId });
    const { generateKeyPair } = await import("jose");
    const foreign = await generateKeyPair(JWT_ALGORITHM, { extractable: true });

    await expect(
      jwtVerify(token, foreign.publicKey, { algorithms: [JWT_ALGORITHM] }),
    ).rejects.toThrow();
  });
});

describe("refresh tokens", () => {
  it("hashes deterministically and never stores the raw value", () => {
    const { token, tokenHash } = generateRefreshToken();
    expect(tokenHash).toBe(hashRefreshToken(token));
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toHaveLength(64);
  });

  it("never repeats", () => {
    const seen = new Set(
      Array.from({ length: 500 }, () => generateRefreshToken().token),
    );
    expect(seen.size).toBe(500);
  });
});
