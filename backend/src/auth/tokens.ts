import { uuidToBase64url } from "@game/Base64.ts";
import { SignJWT } from "jose";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { getSigningKeys, JWT_ALGORITHM } from "./keys.ts";

/**
 * Access tokens must satisfy TokenPayloadSchema (src/core/ApiSchemas.ts):
 *   jti, sub (base64url UUID), iat, iss, aud, exp, role?, provider?
 * and verify under iss/aud from ServerEnv. Anything else is rejected by the
 * game with a bare "invalid token", so the shape is not negotiable.
 */
export interface AccessTokenClaims {
  userId: string;
  role?: string | null;
  provider?: string | null;
}

export async function issueAccessToken({
  userId,
  role,
  provider,
}: AccessTokenClaims): Promise<{ token: string; expiresAt: Date }> {
  const { privateKey, publicJwk } = await getSigningKeys();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.ACCESS_TOKEN_TTL_SECONDS;

  const builder = new SignJWT({
    // The game decodes `sub` back to a UUID; a plain UUID here fails its
    // refine() and the token is rejected.
    ...(role ? { role } : {}),
    ...(provider ? { provider } : {}),
  })
    .setProtectedHeader({ alg: JWT_ALGORITHM, kid: publicJwk.kid })
    .setSubject(uuidToBase64url(userId))
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setExpirationTime(exp);

  return {
    token: await builder.sign(privateKey),
    expiresAt: new Date(exp * 1000),
  };
}

/**
 * Refresh tokens are opaque random strings — never JWTs. A JWT refresh token
 * cannot be revoked before it expires; an opaque one is a row we can delete.
 * Only the hash is stored, so a database leak yields nothing usable.
 */
export const REFRESH_TOKEN_TTL_DAYS = 30;

export function generateRefreshToken(): {
  token: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    ),
  };
}

/**
 * SHA-256 is right here and bcrypt/argon2 would be wrong: these are 256-bit
 * random values, not user-chosen passwords. There is no dictionary to attack,
 * so the only requirement is that the digest be one-way and fast enough to run
 * on every refresh.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Single-use email sign-in token. Same construction as a refresh token — 256
 * bits of entropy, stored only as a hash — but short-lived, because the
 * plaintext sits in an inbox where it may be forwarded, backed up, or scanned
 * by a mail provider.
 */
export function generateLoginToken(ttlMinutes: number): {
  token: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
  };
}
