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

import type { PlayerCosmetics } from "../../src/core/Schemas";
import { GameType } from "../../src/core/game/Game";
import { Client } from "../../src/server/Client";
import { GameServer } from "../../src/server/GameServer";

/**
 * The admin nameplate is cosmetic, but the flag driving it must not be
 * forgeable: it is the visible marker of who holds moderation powers, and a
 * player who could paint it on would be impersonating staff.
 *
 * Unlike the verified badge (a client claim the server validates against the
 * account name), `admin` is never accepted from the client at all — the server
 * overwrites it from the connection's JWT role on join.
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
  role: string | null,
  cosmetics: PlayerCosmetics,
): Client {
  return new Client(
    clientID,
    persistentID,
    null,
    role,
    undefined,
    "127.0.0.1",
    "TestUser",
    null,
    makeMockWs() as any,
    cosmetics,
    undefined,
    [],
  );
}

describe("admin nameplate flag", () => {
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

  function makeGame() {
    return new GameServer(
      "test-game",
      mockLogger,
      Date.now(),
      { gameType: GameType.Private } as any,
      undefined,
    );
  }

  it("is stamped on for an admin role", () => {
    const game = makeGame();
    const client = makeClient("admin-cid", "admin-pid", "admin", {});

    game.joinClient(client);

    expect(client.cosmetics?.admin).toBe(true);
  });

  it("is stamped on for root", () => {
    const game = makeGame();
    const client = makeClient("root-cid", "root-pid", "root", {});

    game.joinClient(client);

    expect(client.cosmetics?.admin).toBe(true);
  });

  it("strips a forged claim from a player with no role", () => {
    // The impersonation case: a modified client sending admin: true.
    const game = makeGame();
    const client = makeClient("rando-cid", "rando-pid", null, {
      admin: true,
    } as PlayerCosmetics);

    game.joinClient(client);

    expect(client.cosmetics?.admin).toBeUndefined();
  });

  it("strips a forged claim from a non-admin role", () => {
    // "mod" moderates but is not an admin; the nameplate marks admin/root.
    const game = makeGame();
    const client = makeClient("mod-cid", "mod-pid", "mod", {
      admin: true,
    } as PlayerCosmetics);

    game.joinClient(client);

    expect(client.cosmetics?.admin).toBeUndefined();
  });

  it("leaves other cosmetics untouched", () => {
    const game = makeGame();
    const client = makeClient("admin-cid", "admin-pid", "admin", {
      verified: true,
    } as PlayerCosmetics);

    game.joinClient(client);

    expect(client.cosmetics?.verified).toBe(true);
    expect(client.cosmetics?.admin).toBe(true);
  });
});
