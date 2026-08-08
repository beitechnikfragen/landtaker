import { base64urlToUuid } from "@game/Base64.ts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import { getSigningKeys, JWT_ALGORITHM } from "../auth/keys.ts";
import { config } from "../config.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireAuth. Absent on unauthenticated routes. */
    userId?: string;
    userRole?: string | null;
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Verifies our own access token. Symmetric with the game's verifyClientToken
 * (src/server/jwt.ts): same algorithm, same issuer/audience, same sub decoding.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "Missing bearer token" });
    return;
  }

  try {
    const { publicKey } = await getSigningKeys();
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });

    const sub = payload.sub;
    if (!sub) {
      await reply.code(401).send({ error: "Token has no subject" });
      return;
    }
    const userId = base64urlToUuid(sub);
    if (!userId) {
      await reply.code(401).send({ error: "Malformed subject" });
      return;
    }

    request.userId = userId;
    request.userRole = (payload.role as string | undefined) ?? null;
  } catch {
    // Deliberately vague: distinguishing "expired" from "bad signature" tells
    // an attacker which half of a forged token was wrong.
    await reply.code(401).send({ error: "Invalid token" });
  }
}

/**
 * Gate for server-to-server routes. The game server sends `x-api-key` on every
 * call it makes to us (see Archive.ts, JoinVerify.ts, jwt.ts).
 */
export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const provided = request.headers["x-api-key"];
  if (typeof provided !== "string" || provided !== config.API_KEY) {
    await reply.code(401).send({ error: "Unauthorized" });
  }
}

/**
 * Populates `request.userId` when a valid bearer token is present, and does
 * nothing at all when it is absent or bad.
 *
 * Separate from requireAuth because that one always 401s without a token,
 * which is right for a private route and wrong for one guests may use. Routes
 * using this MUST treat `request.userId === undefined` as a supported case,
 * not an error.
 *
 * An INVALID token is deliberately treated as no token rather than a 401: the
 * common cause is an access token that expired while a modal sat open, and
 * refusing a bug report over a stale credential — one the reporter cannot even
 * see — would lose the report for no benefit. The submission is simply
 * attributed to nobody.
 */
export async function optionalAuth(request: FastifyRequest): Promise<void> {
  const token = bearerToken(request);
  if (!token) return;

  try {
    const { publicKey } = await getSigningKeys();
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });

    const sub = payload.sub;
    if (!sub) return;
    const userId = base64urlToUuid(sub);
    if (!userId) return;

    request.userId = userId;
    request.userRole = (payload.role as string | undefined) ?? null;
  } catch {
    // Anonymous, not rejected. See the note above.
  }
}
