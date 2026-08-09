import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneTransport } from "../src/client/phone/PhoneTransport";

// ---- Fakes -----------------------------------------------------------
//
// jsdom does not implement WebRTC, so we fake just enough of
// RTCPeerConnection and getUserMedia for PhoneTransport's logic to run.
// The fakes track calls (addTrack, getSenders, negotiation) rather than
// doing anything real with media.

class FakeTrack {
  kind = "audio";
  enabled = true;
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [new FakeTrack()]) {
    this.tracks = tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

interface FakeSender {
  track: FakeTrack | null;
}

let allPeerConnections: FakePeerConnection[] = [];

class FakePeerConnection {
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { streams: FakeMediaStream[] }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  signalingState: "stable" | "have-local-offer" | "have-remote-offer" =
    "stable";
  closed = false;
  iceServers: RTCIceServer[] | undefined;
  iceTransportPolicy: string | undefined;

  private senders: FakeSender[] = [];

  constructor(config?: {
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: string;
  }) {
    this.iceServers = config?.iceServers;
    this.iceTransportPolicy = config?.iceTransportPolicy;
    allPeerConnections.push(this);
  }

  addTrack(track: FakeTrack, _stream: FakeMediaStream): FakeSender {
    const sender: FakeSender = { track };
    this.senders.push(sender);
    // Real WebRTC fires onnegotiationneeded asynchronously (microtask/task)
    // after a track is added post-initial-handshake. Simulate that.
    queueMicrotask(() => this.onnegotiationneeded?.());
    return sender;
  }

  getSenders(): FakeSender[] {
    return this.senders;
  }

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: "fake-offer-sdp" };
  }

  async createAnswer(): Promise<{ type: "answer"; sdp: string }> {
    return { type: "answer", sdp: "fake-answer-sdp" };
  }

  async setLocalDescription(desc: { type: string }): Promise<void> {
    this.signalingState = desc.type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(desc: { type: string }): Promise<void> {
    this.signalingState =
      desc.type === "offer" ? "have-remote-offer" : "stable";
    if (desc.type === "offer") {
      // Simulate the remote's audio arriving alongside the offer so
      // ontrack fires, mirroring real negotiated media.
      this.ontrack?.({ streams: [new FakeMediaStream()] });
    }
  }

  async addIceCandidate(_c: unknown): Promise<void> {}

  close(): void {
    this.closed = true;
  }
}

let getUserMediaCalls = 0;
let getUserMediaImpl: () => Promise<FakeMediaStream> = async () =>
  new FakeMediaStream();

function installFakes(): void {
  allPeerConnections = [];
  getUserMediaCalls = 0;
  getUserMediaImpl = async () => new FakeMediaStream();

  // @ts-expect-error test fake, minimal shape
  global.RTCPeerConnection = FakePeerConnection;

  Object.defineProperty(global.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        getUserMediaCalls++;
        return getUserMediaImpl();
      }),
    },
  });

  // PhoneAudio uses AudioContext / Audio which jsdom doesn't implement.
  // Stub them out so attach()/detach() don't throw; PhoneTransport itself
  // doesn't depend on their internals.
  // @ts-expect-error test fake
  global.AudioContext = class {
    createMediaStreamSource() {
      return { connect: () => this };
    }
    createBiquadFilter() {
      return { connect: () => this, frequency: {}, Q: {} };
    }
    createDynamicsCompressor() {
      return {
        connect: () => this,
        threshold: {},
        ratio: {},
        attack: {},
        release: {},
      };
    }
    createWaveShaper() {
      return { connect: () => this };
    }
    createGain() {
      return { connect: () => this, gain: { value: 1 } };
    }
    close() {
      return Promise.resolve();
    }
    destination = {};
  };
  // @ts-expect-error test fake
  global.Audio = class {
    srcObject: unknown = null;
    muted = false;
    play() {
      return Promise.resolve();
    }
  };
}

const A = "aaaa1111"; // lower id
const B = "bbbb2222"; // higher id

// PhoneTransport reads TURN config from process.env.PHONE_TURN_* (wired via
// vite.config.ts's `define`, same mechanism as API_DOMAIN in Api.ts). Save
// and restore around each test so tests don't leak config into each other.
const ENV_KEYS = [
  "PHONE_TURN_URLS",
  "PHONE_TURN_USERNAME",
  "PHONE_TURN_CREDENTIAL",
  "PHONE_TURN_FORCE_RELAY",
] as const;
let savedEnv: Record<string, string | undefined> = {};

function clearTurnEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("PhoneTransport", () => {
  beforeEach(() => {
    installFakes();
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    clearTurnEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("never creates a peer connection before the local track exists (offer carries audio)", async () => {
    // Mic resolves only after we say so — simulates the real-world race
    // where getUserMedia takes time (permission prompt) while a remote
    // offer/candidates are already arriving. The old behaviour created the
    // peer connection immediately and patched audio in later via
    // renegotiation; the new guarantee is that createPeer() never runs
    // until the mic promise (resolved or denied) has settled.
    let resolveMic!: (s: FakeMediaStream) => void;
    getUserMediaImpl = () =>
      new Promise((resolve) => {
        resolveMic = resolve;
      });

    const sent: unknown[] = [];
    const transport = new PhoneTransport(A, (_to, data) =>
      sent.push(JSON.parse(data)),
    );

    // B (higher id) sends us an offer. handleSignal must await ensureMic()
    // before creating the peer connection, so no RTCPeerConnection exists
    // yet while the mic promise is still pending.
    const handlePromise = transport.handleSignal(
      B,
      JSON.stringify({ type: "offer", sdp: "remote-offer" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(allPeerConnections.length).toBe(0);

    // Now the mic permission prompt resolves.
    resolveMic(new FakeMediaStream());
    await handlePromise;

    // The peer connection is only created now, and it already has the
    // audio track attached — no post-hoc renegotiation needed.
    expect(allPeerConnections.length).toBe(1);
    const pc = allPeerConnections[0];
    const hasAudioSender = pc
      .getSenders()
      .some((s) => s.track?.kind === "audio");
    expect(hasAudioSender).toBe(true);
  });

  it("does not renegotiate: only one offer is ever sent for a given peer", async () => {
    const sent: unknown[] = [];
    const transport = new PhoneTransport(A, (_to, data) =>
      sent.push(JSON.parse(data)),
    );

    await transport.syncPeers([B]);
    // Let any potential renegotiation microtasks flush.
    await new Promise((r) => setTimeout(r, 0));

    const offers = sent.filter((m: any) => m.type === "offer");
    expect(offers.length).toBe(1);

    const pc = allPeerConnections[0];
    expect(pc.onnegotiationneeded).toBeNull();
  });

  it("concurrent ensureMic callers trigger getUserMedia exactly once", async () => {
    let resolveMic!: (s: FakeMediaStream) => void;
    getUserMediaImpl = () =>
      new Promise((resolve) => {
        resolveMic = resolve;
      });

    const transport = new PhoneTransport(A, () => {});

    // syncPeers and handleSignal both call ensureMic() concurrently.
    const p1 = transport.syncPeers([B]);
    const p2 = transport.handleSignal(
      B,
      JSON.stringify({ type: "candidate", candidate: { candidate: "x" } }),
    );

    resolveMic(new FakeMediaStream());
    await Promise.all([p1, p2]);

    expect(getUserMediaCalls).toBe(1);
  });

  it("mic denial leaves micDenied true, no track added, and does not throw", async () => {
    getUserMediaImpl = () => Promise.reject(new Error("NotAllowedError"));

    const transport = new PhoneTransport(A, () => {});
    await expect(transport.syncPeers([B])).resolves.toBeUndefined();

    expect(transport.micDenied).toBe(true);
    const pc = allPeerConnections[0];
    const hasAudioSender = pc
      .getSenders()
      .some((s) => s.track?.kind === "audio");
    expect(hasAudioSender).toBe(false);

    // Further calls remain non-throwing and don't retry getUserMedia.
    await expect(transport.syncPeers([B])).resolves.toBeUndefined();
    expect(getUserMediaCalls).toBe(1);
  });

  it("syncPeers removing a peer closes its connection and detaches audio", async () => {
    const transport = new PhoneTransport(A, () => {});
    await transport.syncPeers([B]);
    expect(allPeerConnections.length).toBe(1);
    const pc = allPeerConnections[0];
    expect(pc.closed).toBe(false);

    await transport.syncPeers([]);
    expect(pc.closed).toBe(true);
  });

  it("only the smaller client id sends the initial offer", async () => {
    const sentFromLower: unknown[] = [];
    const lower = new PhoneTransport(A, (_to, data) =>
      sentFromLower.push(JSON.parse(data)),
    );
    await lower.syncPeers([B]);
    expect(sentFromLower.some((m: any) => m.type === "offer")).toBe(true);

    installFakes();
    const sentFromHigher: unknown[] = [];
    const higher = new PhoneTransport(B, (_to, data) =>
      sentFromHigher.push(JSON.parse(data)),
    );
    await higher.syncPeers([A]);
    expect(sentFromHigher.some((m: any) => m.type === "offer")).toBe(false);
  });

  // Regression test for the production bug: the answering side (higher
  // client id) creates its RTCPeerConnection eagerly inside syncPeers(),
  // *before* any offer has arrived — it never calls makeOffer() itself, it
  // only waits. The inbound offer must still be answered on that
  // syncPeers()-created peer, not just on one created fresh by
  // handleSignal(). This exact path (peer pre-exists, then offer arrives)
  // was previously untested; every other test only covers the offering side.
  it("answers an inbound offer on a peer that syncPeers already created", async () => {
    const sent: unknown[] = [];
    // B is the higher id: syncPeers([A]) will create a peer for A but must
    // NOT send an offer (A < B), mirroring the caller side in production
    // that offers nothing and just waits.
    const transport = new PhoneTransport(B, (_to, data) =>
      sent.push(JSON.parse(data)),
    );

    await transport.syncPeers([A]);
    expect(allPeerConnections.length).toBe(1);
    expect(sent.some((m: any) => m.type === "offer")).toBe(false);

    const preExistingPc = allPeerConnections[0];

    // Now the real offer arrives from A on the very peer syncPeers() built.
    await transport.handleSignal(
      A,
      JSON.stringify({ type: "offer", sdp: "remote-offer-sdp" }),
    );

    // No second RTCPeerConnection should have been constructed for A.
    expect(allPeerConnections.length).toBe(1);
    expect(allPeerConnections[0]).toBe(preExistingPc);

    const answers = sent.filter((m: any) => m.type === "answer") as {
      type: string;
      sdp: string;
    }[];
    expect(answers.length).toBe(1);
    expect(typeof answers[0].sdp).toBe("string");
    expect(preExistingPc.signalingState).toBe("stable");
  });

  // Production logs showed the offer immediately followed by a burst of ICE
  // candidates, all dispatched via PhoneController's fire-and-forget `void
  // this.rtc.handleSignal(...)` with no queueing. Concurrent handleSignal()
  // calls for the same peer must not stop the answer from going out.
  it("answers correctly even when candidates race in concurrently with the offer", async () => {
    const sent: unknown[] = [];
    const transport = new PhoneTransport(B, (_to, data) =>
      sent.push(JSON.parse(data)),
    );

    await transport.syncPeers([A]);

    // Fire off the offer and a handful of candidates without awaiting each
    // individually, exactly as PhoneController.receive() does for a burst of
    // inbound WS messages.
    const offerPromise = transport.handleSignal(
      A,
      JSON.stringify({ type: "offer", sdp: "remote-offer-sdp" }),
    );
    const candidatePromises = Array.from({ length: 6 }, (_, i) =>
      transport.handleSignal(
        A,
        JSON.stringify({
          type: "candidate",
          candidate: { candidate: `cand-${i}` },
        }),
      ),
    );

    await Promise.all([offerPromise, ...candidatePromises]);

    expect(allPeerConnections.length).toBe(1);
    const answers = sent.filter((m: any) => m.type === "answer");
    expect(answers.length).toBe(1);
  });

  describe("ICE server configuration", () => {
    it("no TURN configured -> ICE list contains exactly the two STUN entries", async () => {
      const transport = new PhoneTransport(A, () => {});
      await transport.syncPeers([B]);

      const pc = allPeerConnections[0];
      const iceServers = pc.iceServers ?? [];
      expect(iceServers).toEqual([
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ]);
    });

    it("TURN configured -> list contains STUN plus the TURN entry with the right username/credential", async () => {
      process.env.PHONE_TURN_URLS = "turn:turn.example.com:3478";
      process.env.PHONE_TURN_USERNAME = "turnuser";
      process.env.PHONE_TURN_CREDENTIAL = "turnpass";

      const transport = new PhoneTransport(A, () => {});
      await transport.syncPeers([B]);

      const pc = allPeerConnections[0];
      const iceServers = pc.iceServers ?? [];
      expect(iceServers).toEqual([
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        {
          urls: ["turn:turn.example.com:3478"],
          username: "turnuser",
          credential: "turnpass",
        },
      ]);
    });

    it("blank/whitespace credential is treated as absent, no malformed entry", async () => {
      process.env.PHONE_TURN_URLS = "turn:turn.example.com:3478";
      process.env.PHONE_TURN_USERNAME = "turnuser";
      process.env.PHONE_TURN_CREDENTIAL = "   ";

      const transport = new PhoneTransport(A, () => {});
      await transport.syncPeers([B]);

      const pc = allPeerConnections[0];
      const iceServers = pc.iceServers ?? [];
      expect(iceServers).toEqual([
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ]);
      for (const server of iceServers) {
        expect(server.urls).not.toBe("");
        expect(server.urls).not.toEqual([]);
      }
    });
  });
});
