import { GameRecordSchema, ID } from "@game/Schemas.ts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { requireApiKey } from "../plugins/auth.ts";
import {
  archiveGame,
  getGameRecord,
  normalizeEmptyPersistentIds,
  stripPersistentIds,
  type ArchiveError,
} from "../services/games.ts";

/**
 * The game archive.
 *
 * POST /game/:id — the game server hands us a finished match
 *                  (src/server/Archive.ts archive()).
 * GET  /game/:id — the record comes back, to drive a replay.
 *
 * Both are the game's own routes, so the shapes are not ours to choose: the
 * request body and the response body are both a GameRecord, validated with the
 * game's own GameRecordSchema rather than a local copy of it.
 */

/**
 * 32 MiB. A record holds every intent of every turn, so a long, crowded match
 * is genuinely large — Fastify's 1 MiB default would reject real games. The
 * cap still exists because this endpoint writes to disk.
 */
const MAX_RECORD_BYTES = 32 * 1024 * 1024;

/**
 * The game's own GameRecordSchema, with one tolerance added for a shape the
 * game server genuinely produces.
 *
 * `PlayerRecord.persistentID` is `z.uuid().nullable()`, but GameServer.ts
 * archiveGame() writes `?? ""` for a player who had already disconnected when
 * the record was assembled. The empty string is neither a uuid nor null, so
 * strict validation rejects the whole record — meaning every match where
 * somebody left early would be silently dropped from the archive, replays and
 * all. "" and null mean the same thing here (no account attached), so it is
 * normalised to null on the way in rather than the record being refused.
 *
 * This is deliberately the *only* relaxation: it is derived from the game's
 * schema, so every other field still has to satisfy the real contract.
 */
const IngestGameRecordSchema = z.preprocess(
  normalizeEmptyPersistentIds,
  GameRecordSchema,
);

const STATUS: Record<ArchiveError, number> = {
  id_mismatch: 400,
};

function sendError(reply: FastifyReply, error: ArchiveError) {
  return reply.code(STATUS[error]).send({ error });
}

/** Whether the caller presented the server-to-server api key. */
function hasApiKey(headerValue: unknown): boolean {
  return typeof headerValue === "string" && headerValue === config.API_KEY;
}

export async function registerGameRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /game/:id
   *
   * Server-to-server only: the game server sends `x-api-key`, never a bearer
   * token, so requireApiKey is the guard. Nothing a player controls may write
   * to the archive — a forged record would be replayed as authentic history.
   *
   * The body is capped well above a real record but far below "unbounded": a
   * long match with many players carries every intent of every turn.
   */
  app.post<{ Params: { id: string } }>(
    "/game/:id",
    {
      preHandler: requireApiKey,
      bodyLimit: MAX_RECORD_BYTES,
    },
    async (request, reply) => {
      const gameId = request.params.id;
      if (!ID.safeParse(gameId).success) {
        return reply.code(400).send({ error: "Invalid game ID" });
      }

      // The one normalisation applied to the archived bytes — see
      // normalizeEmptyPersistentIds. Done before validating so that what is
      // checked and what is stored are the same thing.
      const raw = normalizeEmptyPersistentIds(request.body);

      // Validate a copy, store the raw JSON. GameRecordSchema coerces the
      // stats fields to bigint, so the *parsed* value cannot round-trip
      // through JSON.stringify — persisting it would corrupt the replay.
      const parsed = IngestGameRecordSchema.safeParse(raw);
      if (!parsed.success) {
        request.log.warn(
          { gameID: gameId, issues: z.prettifyError(parsed.error) },
          "rejected malformed game record",
        );
        return reply.code(400).send({ error: z.prettifyError(parsed.error) });
      }

      const result = await archiveGame(gameId, {
        raw,
        record: parsed.data,
      });
      if (!result.ok) return sendError(reply, result.error);

      // 201 on first write, 200 on a re-archive. Both are successes — see the
      // upsert rationale in services/games.ts — but the distinction makes a
      // duplicate delivery visible instead of invisible.
      return reply
        .code(result.created ? 201 : 200)
        .send({ gameID: gameId, created: result.created });
    },
  );

  /**
   * GET /game/:id
   *
   * Deliberately unauthenticated. Two very different callers use it: the game
   * server with an api key (Archive.readGameRecord), and the *browser* with no
   * credentials at all (JoinLobbyModal.checkArchivedGame, which fetches the
   * record to start a replay). Requiring the api key here would break replays
   * for every player, so the route is public and the PII is removed instead —
   * only an api-key caller sees persistentIDs.
   *
   * The response body is the bare record, not wrapped in an envelope: both
   * callers parse it directly with GameRecordSchema.
   */
  app.get<{ Params: { id: string } }>("/game/:id", async (request, reply) => {
    const gameId = request.params.id;
    if (!ID.safeParse(gameId).success) {
      return reply.code(400).send({ error: "Invalid game ID" });
    }

    const record = await getGameRecord(gameId);
    // 404, not 200-with-null: the client switches on the status code and
    // treats anything that is neither 200 nor 404 as a hard error.
    if (record === null) {
      return reply.code(404).send({ error: "Game not found" });
    }

    const trusted = hasApiKey(request.headers["x-api-key"]);
    return reply.send(trusted ? record : stripPersistentIds(record));
  });
}
