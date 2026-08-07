import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
  Team,
} from "../../src/core/game/Game";
import {
  assignTeams,
  getMaxTeamSize,
} from "../../src/core/game/TeamAssignment";
import { Client } from "../../src/server/Client";
import { GameServer } from "../../src/server/GameServer";

// A party is grouped through the SOFT (friend) path, not the strict (clan)
// one. assignTeams kicks clan overflow once a team is full, and in a
// variable-size lobby maxTeamSize is ceil(players / teams) — unknown while
// people are still joining. The client only refuses party joins for the
// fixed-size modes, so a variable-size lobby admits a party of any size;
// grouping it strictly would kick someone out of a match they were allowed
// to join. These tests pin both halves of that: members do land together
// when there is room, and nobody is ever benched when there isn't.

function makeGame() {
  const logger: any = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return new GameServer("g1", logger, Date.now(), {
    gameType: GameType.Private,
    gameMode: GameMode.Team,
  } as any);
}

function makeClient(
  clientID: string,
  publicId: string,
  friends: string[] = [],
) {
  return new Client(
    clientID,
    `pid-${clientID}`,
    null,
    null,
    undefined,
    "1.2.3.4",
    clientID,
    null,
    { readyState: 1, send: vi.fn() } as any,
    undefined,
    publicId,
    friends,
  );
}

// Drives the real buildFriendsLookup over a set of clients.
function friendsFor(game: GameServer, clients: Client[]) {
  (game as any).activeClients = clients;
  const lookup = (game as any).buildFriendsLookup();
  return (c: Client) => lookup(c) as string[] | undefined;
}

const record = (game: GameServer, publicId: string, members: string[]) =>
  game.recordPartyMembers(publicId, members);

describe("party membership becomes friend edges", () => {
  let game: GameServer;
  beforeEach(() => {
    game = makeGame();
  });

  it("emits every other party member as a friend edge", () => {
    const a = makeClient("a", "pub-a");
    const b = makeClient("b", "pub-b");
    const c = makeClient("c", "pub-c");
    // All three snapshotted the same full roster.
    for (const pid of ["pub-a", "pub-b", "pub-c"]) {
      record(game, pid, ["pub-a", "pub-b", "pub-c"]);
    }
    const lookup = friendsFor(game, [a, b, c]);
    expect(lookup(a)).toEqual(["b", "c"]);
    expect(lookup(b)).toEqual(["a", "c"]);
    expect(lookup(c)).toEqual(["a", "b"]);
  });

  it("never lists the player as their own friend", () => {
    const a = makeClient("a", "pub-a");
    record(game, "pub-a", ["pub-a"]);
    expect(friendsFor(game, [a])(a)).toBeUndefined();
  });

  it("drops party members who are not in this game", () => {
    const a = makeClient("a", "pub-a");
    record(game, "pub-a", ["pub-a", "pub-absent"]);
    expect(friendsFor(game, [a])(a)).toBeUndefined();
  });

  it("is symmetric when only one side's snapshot names the other", () => {
    // B joined the party after A already joined the lobby, so A's frozen
    // roster predates B. The edge must still exist both ways, otherwise
    // grouping would depend on lobby join order.
    const a = makeClient("a", "pub-a");
    const b = makeClient("b", "pub-b");
    record(game, "pub-a", ["pub-a"]);
    record(game, "pub-b", ["pub-a", "pub-b"]);
    const lookup = friendsFor(game, [a, b]);
    expect(lookup(a)).toEqual(["b"]);
    expect(lookup(b)).toEqual(["a"]);
  });

  it("merges account friends with party members without duplicating", () => {
    const a = makeClient("a", "pub-a", ["pub-b"]);
    const b = makeClient("b", "pub-b", ["pub-a"]);
    record(game, "pub-a", ["pub-a", "pub-b"]);
    record(game, "pub-b", ["pub-a", "pub-b"]);
    const lookup = friendsFor(game, [a, b]);
    expect(lookup(a)).toEqual(["b"]);
    expect(lookup(b)).toEqual(["a"]);
  });

  it("leaves non-party players alone", () => {
    const a = makeClient("a", "pub-a");
    const solo = makeClient("solo", "pub-solo");
    record(game, "pub-a", ["pub-a", "pub-b"]);
    expect(friendsFor(game, [a, solo])(solo)).toBeUndefined();
  });

  it("ignores a client with no publicId (anonymous join)", () => {
    const anon = makeClient("anon", undefined as any);
    (anon as any).publicId = undefined;
    record(game, "pub-a", ["pub-a", "pub-b"]);
    expect(friendsFor(game, [anon])(anon)).toBeUndefined();
  });
});

// --- The assignment itself -------------------------------------------------

function playerInfo(
  clientID: string,
  friends: string[] = [],
  clanTag: string | null = null,
): PlayerInfo {
  return {
    id: clientID,
    clientID,
    playerType: PlayerType.Human,
    clanTag,
    friends,
    teamIndex: null,
  } as unknown as PlayerInfo;
}

const teamOf = (
  result: Map<PlayerInfo, Team | "kicked">,
  p: PlayerInfo,
): Team | "kicked" => result.get(p)!;

describe("party members land on the same team", () => {
  it("keeps a 3-party together in a lobby with room", () => {
    const teams = ["T1", "T2"] as unknown as Team[];
    // a,b,c are a party (clique edges); d,e,f are unaffiliated.
    const a = playerInfo("a", ["b", "c"]);
    const b = playerInfo("b", ["a", "c"]);
    const c = playerInfo("c", ["a", "b"]);
    const d = playerInfo("d");
    const e = playerInfo("e");
    const f = playerInfo("f");
    const result = assignTeams([a, b, c, d, e, f], teams, false, 3);
    expect(teamOf(result, a)).toBe(teamOf(result, b));
    expect(teamOf(result, b)).toBe(teamOf(result, c));
    expect(teamOf(result, a)).not.toBe("kicked");
  });

  it("kicks nobody when the party is larger than a team (variable size)", () => {
    // The bad outcome the soft path exists to prevent: a 5-party in a lobby
    // whose teams are smaller than the party. The client's fit gate lets
    // this join through because seats are not knowable at join time.
    // Members may be SPLIT across teams, but every one of them must play.
    //
    // maxTeamSize comes from the real derivation (ceil(players / teams)),
    // which is how a variable-size lobby actually sizes itself — never a
    // hand-picked number, or the lobby would be over-subscribed before
    // grouping even runs.
    const teams = ["T1", "T2"] as unknown as Team[];
    const party = ["a", "b", "c", "d", "e"];
    const players = party.map((id) =>
      playerInfo(
        id,
        party.filter((o) => o !== id),
      ),
    );
    const extra = [playerInfo("x"), playerInfo("y")];
    const all = [...players, ...extra];
    const result = assignTeams(
      all,
      teams,
      false,
      getMaxTeamSize(all.length, teams.length),
    );

    for (const p of all) {
      expect(teamOf(result, p)).not.toBe("kicked");
    }
    // The party genuinely does not fit on one team (4 seats, 5 members), so
    // this is the spill case, not a lucky fit.
    const partyTeams = new Set(players.map((p) => teamOf(result, p)));
    expect(partyTeams.size).toBeGreaterThan(1);
  });

  it("contrast: the clan path DOES kick overflow (why parties avoid it)", () => {
    // Same shape as above but grouped strictly. This is the behaviour that
    // would hit a party if it were routed down the clan path — documented
    // here so the choice is not silently reverted.
    const teams = ["T1", "T2"] as unknown as Team[];
    const clan = ["a", "b", "c", "d", "e"].map((id) =>
      playerInfo(id, [], "PTY"),
    );
    const all = [...clan, playerInfo("x"), playerInfo("y")];
    const result = assignTeams(
      all,
      teams,
      false,
      getMaxTeamSize(all.length, teams.length),
    );
    // Same population and the same seat maths as the soft-path test above,
    // which kicked nobody — the kicks here come purely from clan strictness.
    const kicked = clan.filter((p) => teamOf(result, p) === "kicked");
    expect(kicked.length).toBeGreaterThan(0);
  });

  it("is deterministic: identical inputs give an identical assignment", () => {
    const build = () => {
      const teams = ["T1", "T2"] as unknown as Team[];
      const party = ["a", "b", "c"];
      const players = party.map((id) =>
        playerInfo(
          id,
          party.filter((o) => o !== id),
        ),
      );
      const rest = ["w", "x", "y", "z"].map((id) => playerInfo(id));
      const all = [...players, ...rest];
      const result = assignTeams(all, teams, false, 4);
      return all.map((p) => `${p.clientID}:${String(teamOf(result, p))}`);
    };
    expect(build()).toEqual(build());
  });
});
