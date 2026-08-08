import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/Schemas", async () => {
  const actual = (await vi.importActual("../../src/core/Schemas")) as any;
  return {
    ...actual,
    GameStartInfoSchema: {
      safeParse: (data: any) => ({ success: true, data: data }),
    },
    ServerPrestartMessageSchema: {
      safeParse: (data: any) => ({ success: true, data: data }),
    },
    ClientMessageSchema: {
      safeParse: (data: any) => ({ success: true, data: data }),
    },
  };
});

import { GameType } from "../../src/core/game/Game";
import { Client } from "../../src/server/Client";
import { GameServer } from "../../src/server/GameServer";

/**
 * This is THE test for admin cheats.
 *
 * The simulation runs on every client and has no concept of an admin: once an
 * admin_cheat intent is inside a turn, every client applies it unconditionally.
 * GameServer.handleIntent refusing to enqueue it is therefore the entire
 * security boundary — there is no downstream check to fall back on. If these
 * assertions ever stop holding, any player can grant themselves god mode.
 */

function makeMockWs() {
  const handlers: Record<string, (...args: any[]) => any> = {};
  return {
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers[event] = handler;
    },
    removeAllListeners: (_event: string) => {},
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    trigger: (event: string, ...args: any[]) => handlers[event]?.(...args),
  };
}

function makeClient(
  clientID: string,
  persistentID: string,
  role?: string,
): { client: Client; ws: ReturnType<typeof makeMockWs> } {
  const ws = makeMockWs();
  const client = new Client(
    clientID,
    persistentID,
    null,
    role ?? null,
    undefined,
    "127.0.0.1",
    "TestUser",
    null,
    ws as any,
    undefined,
    undefined,
    [],
  );
  return { client, ws };
}

describe("GameServer — admin_cheat authorization", () => {
  let mockLogger: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  function makeGame(creatorPersistentID?: string) {
    return new GameServer(
      "test-game",
      mockLogger,
      Date.now(),
      { gameType: GameType.Private } as any,
      creatorPersistentID,
    );
  }

  /** Puts the server past the not-started guard so role is the only variable. */
  function startGame(game: GameServer) {
    game.prestart();
    game.start();
  }

  function cheatIntent(action = "give_gold", amount = 1_000_000) {
    return { type: "admin_cheat", action, amount };
  }

  function outcomeFor(
    game: GameServer,
    client: Client,
    isAdmin: boolean,
    intent: object = cheatIntent(),
  ) {
    return game.handleIntent(intent as any, {
      clientID: client.clientID,
      isLobbyCreator: false,
      isAdmin,
      isAdminBot: false,
    });
  }

  it("refuses a player with no role", () => {
    const game = makeGame();
    const { client } = makeClient("rando-cid", "rando-pid");
    game.joinClient(client);
    startGame(game);

    const outcome = outcomeFor(game, client, false);

    expect(outcome.status).toBe(403);
    expect(outcome.error).toBe("admin role required");
  });

  it("accepts a player holding an admin role", () => {
    const game = makeGame();
    const { client } = makeClient("admin-cid", "admin-pid", "admin");
    game.joinClient(client);
    startGame(game);

    const outcome = outcomeFor(game, client, true);

    expect(outcome.status).toBe(200);
  });

  it("refuses the lobby creator when they are not an admin", () => {
    // Hosting a lobby is not a grant of cheat powers — otherwise anyone could
    // create a private game, invite players, and cheat against them.
    const game = makeGame("creator-pid");
    const { client } = makeClient("creator-cid", "creator-pid");
    game.joinClient(client);
    startGame(game);

    const outcome = game.handleIntent(cheatIntent() as any, {
      clientID: client.clientID,
      isLobbyCreator: true,
      isAdmin: false,
      isAdminBot: false,
    });

    expect(outcome.status).toBe(403);
  });

  it("refuses cheats before the game starts", () => {
    const game = makeGame();
    const { client } = makeClient("admin-cid", "admin-pid", "admin");
    game.joinClient(client);

    const outcome = outcomeFor(game, client, true);

    expect(outcome.status).toBe(409);
  });

  it("refuses every cheat action to a non-admin, not just give_gold", () => {
    const game = makeGame();
    const { client } = makeClient("rando-cid", "rando-pid");
    game.joinClient(client);
    startGame(game);

    // A gate that only covered the action someone happened to test would be
    // worse than none — it would read as protection.
    for (const action of [
      "give_gold",
      "give_troops",
      "set_troops",
      "spawn_unit",
      "capture_tile",
      "god_mode",
      "kill_player",
      "force_alliance",
      "break_alliance",
    ]) {
      const outcome = outcomeFor(game, client, false, cheatIntent(action));
      expect(outcome.status).toBe(403);
    }
  });

  it("does not enqueue a refused cheat into a turn", () => {
    // The status code is not the thing that matters — reaching the turn is.
    // An intent that lands in a turn is executed by every client regardless of
    // what the server told the sender.
    const game = makeGame();
    const { client } = makeClient("rando-cid", "rando-pid");
    game.joinClient(client);
    startGame(game);

    const addIntent = vi.spyOn(game as any, "addIntent");
    outcomeFor(game, client, false);

    expect(addIntent).not.toHaveBeenCalled();
  });

  it("enqueues an authorized cheat into a turn", () => {
    const game = makeGame();
    const { client } = makeClient("admin-cid", "admin-pid", "admin");
    game.joinClient(client);
    startGame(game);

    const addIntent = vi.spyOn(game as any, "addIntent");
    outcomeFor(game, client, true);

    expect(addIntent).toHaveBeenCalledOnce();
  });

  it("stamps the sender's clientID rather than trusting the payload", () => {
    // Without this, an admin could attribute a cheat to another player.
    const game = makeGame();
    const { client } = makeClient("admin-cid", "admin-pid", "admin");
    game.joinClient(client);
    startGame(game);

    const addIntent = vi.spyOn(game as any, "addIntent");
    game.handleIntent({ ...cheatIntent(), clientID: "someone-else" } as any, {
      clientID: client.clientID,
      isLobbyCreator: false,
      isAdmin: true,
      isAdminBot: false,
    });

    expect(addIntent).toHaveBeenCalledWith(
      expect.objectContaining({ clientID: "admin-cid" }),
    );
  });
});
