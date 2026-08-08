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

  private senders: FakeSender[] = [];

  constructor() {
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

describe("PhoneTransport", () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches an outgoing audio track to a peer created before the mic resolved (regression)", async () => {
    // Mic never resolves until we say so — simulates the real-world race
    // where getUserMedia takes seconds (permission prompt) while a remote
    // offer/candidates are already arriving.
    let resolveMic!: (s: FakeMediaStream) => void;
    getUserMediaImpl = () =>
      new Promise((resolve) => {
        resolveMic = resolve;
      });

    const sent: unknown[] = [];
    const transport = new PhoneTransport(A, (_to, data) =>
      sent.push(JSON.parse(data)),
    );

    // B (higher id) sends us an offer. handleSignal creates the peer
    // connection immediately, but ensureMic() is still pending.
    const handlePromise = transport.handleSignal(
      B,
      JSON.stringify({ type: "offer", sdp: "remote-offer" }),
    );

    // At this point the peer connection exists but has no audio sender.
    expect(allPeerConnections.length).toBe(1);
    expect(allPeerConnections[0].getSenders().length).toBe(0);

    // Now the mic permission prompt resolves.
    resolveMic(new FakeMediaStream());
    await handlePromise;
    // Let the ensureMic() continuation (attachMicToExistingPeers) run.
    await new Promise((r) => setTimeout(r, 0));

    const pc = allPeerConnections[0];
    const hasAudioSender = pc
      .getSenders()
      .some((s) => s.track?.kind === "audio");
    expect(hasAudioSender).toBe(true);
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
});
