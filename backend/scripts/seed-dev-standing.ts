/**
 * Gives dev accounts a visible standing: ranked elo with a win/loss record,
 * and a handful of archived matches for the recent-matches strip.
 *
 * DEVELOPMENT TOOL. It writes through the same archiveGame service the real
 * ingest uses, so the participant linking and promoted columns are the real
 * thing — only the records themselves are fixtures.
 *
 * Usage:
 *   npx tsx scripts/seed-dev-standing.ts [email]     # one account
 *   npx tsx scripts/seed-dev-standing.ts --all-dev   # every @dev.localhost account
 *
 * The default email matches what /auth/dev-login assigns: the lower-cased
 * username at @dev.localhost.
 */
import { eq, like } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { leaderboardEntries, users } from "../src/db/schema.ts";
import { buildGameRecord } from "../src/services/gameRecordFixture.ts";
import { archiveGame } from "../src/services/games.ts";

type DevUser = typeof users.$inferSelect;

// Newest last so the strip's DESC ordering is exercised. The fixture's
// player[0] carries clientID "aBcD1234"; making that player the caller and
// toggling the winner tuple flips win/loss per game.
const MATCHES = [
  { map: "Europe", mode: "Free For All", won: true, hoursAgo: 26 },
  { map: "World", mode: "Team", won: false, hoursAgo: 20 },
  { map: "Black Sea", mode: "Free For All", won: false, hoursAgo: 8 },
  { map: "Pangaea", mode: "Free For All", won: true, hoursAgo: 3 },
  { map: "Baikal", mode: "Team", won: false, hoursAgo: 1 },
] as const;

async function seedUser(user: DevUser): Promise<void> {
  console.log(`Seeding ${user.usernameBase ?? user.publicId} (${user.id})`);

  // Gold territory under the provisional thresholds (RankBadge.ts): 1842
  // lands in Gold II with headroom on the progress bar.
  for (const entry of [
    { mode: "1v1", elo: 1842, wins: 47, losses: 31 },
    { mode: "2v2", elo: 1210, wins: 4, losses: 9 },
  ]) {
    await db
      .insert(leaderboardEntries)
      .values({ userId: user.id, ...entry })
      .onConflictDoUpdate({
        target: [leaderboardEntries.userId, leaderboardEntries.mode],
        set: { elo: entry.elo, wins: entry.wins, losses: entry.losses },
      });
    console.log(
      `  ${entry.mode}: elo ${entry.elo} (${entry.wins}W/${entry.losses}L)`,
    );
  }

  // Game ids must differ per user: archiveGame REPLACES the participant rows
  // of an existing game, so a shared id would steal the match from whichever
  // account was seeded before.
  const idPrefix = `S${user.id.replace(/-/g, "").slice(0, 5)}`;

  for (const [index, match] of MATCHES.entries()) {
    const gameID = `${idPrefix}0${index}`;
    // The real ingest receives the record as JSON over HTTP, so BigInts
    // (gold) never reach the DB layer. Round-trip through JSON the same way.
    const record = JSON.parse(
      JSON.stringify(buildGameRecord({ gameID }), (_k, v) =>
        typeof v === "bigint" ? Number(v) : v,
      ),
    );
    const info = record.info as {
      players: { persistentID?: string; clientID: string }[];
      winner?: unknown;
      config: { gameMap: string; gameMode: string };
      start: number;
      end: number;
    };
    info.players[0].persistentID = user.id;
    info.config.gameMap = match.map;
    info.config.gameMode = match.mode;
    const end = Date.now() - match.hoursAgo * 3_600_000;
    info.start = end - 612_000;
    info.end = end;
    info.winner = match.won
      ? ["player", info.players[0].clientID]
      : ["player", info.players[1]?.clientID ?? info.players[0].clientID];

    const result = await archiveGame(gameID, { raw: record, record });
    console.log(
      `  ${gameID} ${match.map} (${match.won ? "win" : "loss"}):`,
      result,
    );
  }
}

const arg = process.argv[2] ?? "oemer@dev.localhost";

const targets: DevUser[] =
  arg === "--all-dev"
    ? await db.query.users.findMany({
        where: like(users.email, "%@dev.localhost"),
      })
    : await db.query.users
        .findFirst({ where: eq(users.email, arg) })
        .then((user) => (user ? [user] : []));

if (targets.length === 0) {
  console.error(
    `No matching user (${arg}). Sign in via the dev button first — ` +
      `it creates the account this script decorates.`,
  );
  process.exit(1);
}

for (const user of targets) {
  await seedUser(user);
}

console.log("Done. Reload the app — the rail now has a standing.");
process.exit(0);
