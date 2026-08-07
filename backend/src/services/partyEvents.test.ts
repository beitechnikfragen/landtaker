import { PartyResponseSchema, PartySchema } from "@game/PartyApiSchemas.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SSE fan-out is covered end to end (real Postgres, real Redis) by
 * scripts/smoke-party-events.sh. What is asserted here is what a smoke script
 * cannot show: that the payload matches the shared schema, that a disconnect
 * actually releases the subscription, and that Redis being down degrades
 * instead of throwing.
 *
 * Redis is faked so these run with no infrastructure. The fake mimics the two
 * ioredis behaviours that matter: duplicate() yields an independent client, and
 * a 'message' event carries (channel, payload).
 */

/** Minimal stand-in for an ioredis client in subscriber mode. */
class FakeRedis {
  handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  subscribedChannels: string[] = [];
  published: Array<[string, string]> = [];
  connected = false;
  disconnected = false;
  /** When set, connect()/subscribe()/publish() reject with it. */
  failWith: Error | null = null;

  on(event: string, handler: (...args: unknown[]) => void): this {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  duplicate(): FakeRedis {
    const copy = new FakeRedis();
    copy.failWith = this.failWith;
    duplicates.push(copy);
    return copy;
  }

  async connect(): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.connected = true;
  }

  async subscribe(channel: string): Promise<number> {
    if (this.failWith) throw this.failWith;
    this.subscribedChannels.push(channel);
    return this.subscribedChannels.length;
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.failWith) throw this.failWith;
    this.published.push([channel, message]);
    // Loop back to every subscriber, the way a real Redis broker would.
    for (const client of duplicates) {
      for (const handler of client.handlers.get("message") ?? []) {
        handler(channel, message);
      }
    }
    return 1;
  }

  async quit(): Promise<void> {
    this.connected = false;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

let duplicates: FakeRedis[] = [];
const fakeRedis = new FakeRedis();

vi.mock("../redis.ts", () => ({
  redis: fakeRedis,
  closeRedis: async () => {},
}));

// Imported after the mock is registered so the service picks up the fake.
const {
  closePartyEvents,
  listenerCount,
  publishPartyChanged,
  subscribeToParty,
  watchedPartyCount,
} = await import("./partyEvents.ts");

beforeEach(() => {
  fakeRedis.failWith = null;
  fakeRedis.published = [];
  duplicates = [];
});

afterEach(async () => {
  await closePartyEvents();
});

describe("party event payload", () => {
  /**
   * The stream reuses the REST party shape so the client can render straight
   * from the event. If PartySchema gains a required field, a payload built the
   * old way must fail here rather than at a user's browser.
   */
  it("carries a party that satisfies the shared schema", () => {
    const payload = {
      party: {
        id: "11111111-1111-1111-1111-111111111111",
        inviteCode: "ACDEFG",
        isOpen: false,
        maxMembers: 4,
        leaderId: "22222222-2222-2222-2222-222222222222",
        viewerId: "22222222-2222-2222-2222-222222222222",
        members: [
          {
            userId: "22222222-2222-2222-2222-222222222222",
            publicId: "pub-1",
            username: "Alpha.1234",
            isLeader: true,
            joinedAt: new Date().toISOString(),
          },
        ],
      },
    };

    expect(() => PartyResponseSchema.parse(payload)).not.toThrow();
    // And it must survive the JSON round trip the wire actually performs.
    expect(() =>
      PartySchema.parse(JSON.parse(JSON.stringify(payload.party))),
    ).not.toThrow();
  });

  /** A kicked member is told `party: null`, which the same schema must allow. */
  it("allows a null party for a member who is no longer in one", () => {
    expect(() => PartyResponseSchema.parse({ party: null })).not.toThrow();
  });
});

describe("subscription lifecycle", () => {
  it("delivers a published change to a subscribed listener", async () => {
    const seen: string[] = [];
    await subscribeToParty("party-a", (id) => seen.push(id));

    await publishPartyChanged("party-a");

    expect(seen).toEqual(["party-a"]);
  });

  it("does not deliver another party's changes", async () => {
    const seen: string[] = [];
    await subscribeToParty("party-a", (id) => seen.push(id));

    await publishPartyChanged("party-b");

    expect(seen).toEqual([]);
  });

  /**
   * The leak that matters: an SSE client that reconnects repeatedly must not
   * leave a listener behind each time. After unsubscribing, the party must hold
   * zero listeners AND the map entry itself must be gone.
   */
  it("releases the listener on disconnect", async () => {
    const seen: string[] = [];
    const unsubscribe = await subscribeToParty("party-a", (id) =>
      seen.push(id),
    );
    expect(listenerCount("party-a")).toBe(1);

    unsubscribe();

    expect(listenerCount("party-a")).toBe(0);
    // The bucket is deleted, not left as an empty Set — otherwise the map grows
    // by one entry per party ever watched and never shrinks.
    expect(watchedPartyCount()).toBe(0);

    await publishPartyChanged("party-a");
    expect(seen).toEqual([]);
  });

  it("does not accumulate listeners across repeated reconnects", async () => {
    for (let i = 0; i < 50; i++) {
      const unsubscribe = await subscribeToParty("party-a", () => {});
      unsubscribe();
    }

    expect(listenerCount("party-a")).toBe(0);
    expect(watchedPartyCount()).toBe(0);
  });

  it("uses one shared Redis subscriber no matter how many clients connect", async () => {
    for (let i = 0; i < 10; i++) {
      await subscribeToParty(`party-${i}`, () => {});
    }

    // One duplicated connection for the whole process, not one per client.
    expect(duplicates.length).toBe(1);
    expect(watchedPartyCount()).toBe(10);
  });

  it("keeps other listeners on the same party alive when one leaves", async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubA = await subscribeToParty("party-a", (id) => seenA.push(id));
    await subscribeToParty("party-a", (id) => seenB.push(id));

    unsubA();
    await publishPartyChanged("party-a");

    expect(seenA).toEqual([]);
    expect(seenB).toEqual(["party-a"]);
    expect(listenerCount("party-a")).toBe(1);
  });

  it("tolerates unsubscribing twice", async () => {
    const unsubscribe = await subscribeToParty("party-a", () => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    expect(listenerCount("party-a")).toBe(0);
  });

  /**
   * A listener that throws must not take down its neighbours — one bad SSE
   * connection cannot be allowed to stop everyone else's updates.
   */
  it("isolates a throwing listener from the others", async () => {
    const seen: string[] = [];
    await subscribeToParty("party-a", () => {
      throw new Error("listener exploded");
    });
    await subscribeToParty("party-a", (id) => seen.push(id));

    await expect(publishPartyChanged("party-a")).resolves.toBeUndefined();
    expect(seen).toEqual(["party-a"]);
  });
});

describe("when Redis is unavailable", () => {
  it("still returns a working unsubscribe from subscribeToParty", async () => {
    fakeRedis.failWith = new Error("ECONNREFUSED");

    const unsubscribe = await subscribeToParty("party-a", () => {});

    expect(typeof unsubscribe).toBe("function");
    expect(listenerCount("party-a")).toBe(1);
    unsubscribe();
    expect(listenerCount("party-a")).toBe(0);
  });

  it("does not throw when subscribing", async () => {
    fakeRedis.failWith = new Error("ECONNREFUSED");
    await expect(subscribeToParty("party-a", () => {})).resolves.toBeTypeOf(
      "function",
    );
  });

  /**
   * A join must succeed even with Redis down — the mutation is committed in
   * Postgres by the time we publish, so a rejection here would fail a request
   * whose work is already done.
   */
  it("does not throw when publishing", async () => {
    fakeRedis.failWith = new Error("ECONNREFUSED");
    await expect(publishPartyChanged("party-a")).resolves.toBeUndefined();
  });

  it("discards the half-open subscriber so a later attempt can retry", async () => {
    fakeRedis.failWith = new Error("ECONNREFUSED");
    await subscribeToParty("party-a", () => {});

    expect(duplicates.length).toBe(1);
    expect(duplicates[0]!.disconnected).toBe(true);
    // The failed client must not be left listening for messages.
    expect(duplicates[0]!.listenerCount("message")).toBe(0);

    // Redis comes back; the next subscriber gets a fresh connection.
    fakeRedis.failWith = null;
    const seen: string[] = [];
    await subscribeToParty("party-b", (id) => seen.push(id));

    expect(duplicates.length).toBe(2);
    await publishPartyChanged("party-b");
    expect(seen).toEqual(["party-b"]);
  });
});
