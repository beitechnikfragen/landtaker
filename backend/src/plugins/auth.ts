import { isAdminRole } from "@game/ApiSchemas.ts";
import { base64urlToUuid } from "@game/Base64.ts";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import { getSigningKeys, JWT_ALGORITHM } from "../auth/keys.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";

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
 * Gate for /admin/*. Runs requireAuth first, then re-reads the role from the
 * database.
 *
 * The re-read is the point. Access tokens live ~15 minutes and carry the role
 * as a claim, so a demoted or compromised admin would keep full panel access
 * for the remainder of their token's life — long enough to grant themselves a
 * fresh one. These routes edit roles, credits and bans, so that window is not
 * acceptable; every admin request pays one indexed primary-key lookup instead.
 *
 * `request.userRole` is overwritten with the authoritative value so handlers
 * downstream (notably the root-only checks) never see the stale claim.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(request, reply);
  // requireAuth already answered; anything further would be a second send.
  if (reply.sent) return;

  const user = await db.query.users.findFirst({
    where: eq(users.id, request.userId!),
    columns: { role: true },
  });

  if (!isAdminRole(user?.role)) {
    // 404, not 403: a 403 confirms /admin/* exists and that the caller's token
    // is valid but under-privileged. There is nothing to gain from telling a
    // non-admin either fact.
    await reply.code(404).send({ error: "Not found" });
    return;
  }

  request.userRole = user!.role;
}

/**
 * Gate for the handful of actions only `root` may take — currently promoting
 * or demoting an admin. Assumes requireAdmin has already run and refreshed
 * `request.userRole` from the database.
 */
export function isRoot(request: FastifyRequest): boolean {
  return request.userRole === "root";
}
