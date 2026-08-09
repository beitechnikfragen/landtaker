import { TurnCredentialsResponseSchema } from "../../core/ApiSchemas";
import type { ClientID } from "../../core/Schemas";
import { getApiBase } from "../Api";
import { ClientEnv } from "../ClientEnv";
import { PhoneAudio } from "./PhoneAudio";

const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * TURN entry the client actually uses to build ICE server lists — either the
 * build-time PHONE_TURN_* override or the shape returned by
 * GET /phone/turn-credentials.
 */
interface TurnConfig {
  urls: string[];
  username: string;
  credential: string;
}

// Build-time override / escape hatch for a hosted TURN provider (or a manual
// pin), takes precedence over fetched self-hosted credentials whenever all
// three vars are non-blank. See docs/PhoneTurn.md "Precedence".
function buildTimeTurnConfig(): TurnConfig | null {
  const urls = ClientEnv.phoneTurnUrls();
  const username = ClientEnv.phoneTurnUsername();
  const credential = ClientEnv.phoneTurnCredential();
  if (urls.length === 0 || username.length === 0 || credential.length === 0) {
    return null;
  }
  return { urls, username, credential };
}

/**
 * Fetches ephemeral TURN credentials from the backend (self-hosted coturn,
 * see docs/PhoneTurn.md). Cached module-wide for the credential's lifetime —
 * every PhoneTransport instance in this tab shares one fetch instead of
 * hitting the endpoint per call.
 *
 * Never throws: a TURN outage must degrade the call to STUN-only, never break
 * the client. Returns null on any failure (network error, non-2xx, malformed
 * body, or a well-formed-but-empty response, which is what the backend sends
 * when it has no TURN configured either).
 */
let fetchedTurnConfig: Promise<TurnConfig | null> | null = null;

/** Test-only: clears the module-wide cached fetch between test cases. */
export function resetTurnConfigCacheForTests(): void {
  fetchedTurnConfig = null;
}

function fetchTurnConfig(myId: ClientID): Promise<TurnConfig | null> {
  if (fetchedTurnConfig) return fetchedTurnConfig;
  fetchedTurnConfig = (async () => {
    try {
      const url = `${getApiBase()}/phone/turn-credentials?clientId=${encodeURIComponent(myId)}`;
      const response = await fetch(url);
      if (!response.ok) {
        console.log(
          `[phone] TURN credential fetch failed: HTTP ${response.status} — falling back to STUN-only`,
        );
        return null;
      }
      const parsed = TurnCredentialsResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        console.log(
          "[phone] TURN credential fetch returned an unparseable body — falling back to STUN-only",
        );
        return null;
      }
      const { urls, username, credential } = parsed.data;
      if (
        urls.length === 0 ||
        username.length === 0 ||
        credential.length === 0
      ) {
        // The backend has no self-hosted TURN configured either — not an
        // error, just nothing to add.
        return null;
      }
      return { urls, username, credential };
    } catch (err) {
      console.log(
        `[phone] TURN credential fetch threw — falling back to STUN-only: ${err}`,
      );
      return null;
    }
  })();
  return fetchedTurnConfig;
}

// STUN alone leaves players behind strict/symmetric NATs with no working ICE
// path (connectionState goes connecting -> failed on both sides, confirmed in
// production logs even though signaling and ontrack both succeed). TURN is
// the fallback for that ~10-15% of players.
//
// Never emits a malformed RTCIceServer (an empty `urls` throws). The
// build-time PHONE_TURN_* vars are checked first (manual override / hosted
// provider escape hatch); only when none of those are set does this reach out
// for the self-hosted, backend-issued ephemeral credential.
let loggedIceConfig = false;
async function buildIceServers(myId: ClientID): Promise<RTCIceServer[]> {
  const turn = buildTimeTurnConfig() ?? (await fetchTurnConfig(myId));
  const servers = [...STUN_SERVERS];
  if (turn) {
    servers.push({
      urls: turn.urls,
      username: turn.username,
      credential: turn.credential,
    });
  }
  if (!loggedIceConfig) {
    loggedIceConfig = true;
    // Diagnostic: confirms a deploy picked up the TURN config. Never logs
    // the credential (or username, out of caution).
    console.log(
      `[phone] ICE config: ${servers.length} server(s), TURN=${turn ? "present" : "absent"}`,
    );
  }
  return servers;
}

interface Peer {
  pc: RTCPeerConnection;
  audio: PhoneAudio;
}

export class PhoneTransport {
  private peers = new Map<ClientID, Peer>();
  private localStream: MediaStream | null = null;
  private _micDenied = false;
  private muted = false;
  private volume = 1;
  // In-flight getUserMedia() promise. Concurrent callers (syncPeers and
  // handleSignal can race) await this instead of each starting their own
  // permission prompt / stream.
  private micPromise: Promise<void> | null = null;
  // Per-peer signaling queue. PhoneController dispatches every inbound
  // "signal" message via a fire-and-forget `void handleSignal(...)` — there
  // is no server-side or transport-level ordering guarantee that one
  // message's async work (setRemoteDescription -> createAnswer ->
  // setLocalDescription for an offer) finishes before the next message for
  // the same peer starts running. In production this let ICE candidates for
  // a peer interleave with that peer's own still-in-flight offer handling.
  // Chaining onto this promise per peer forces strict in-order processing
  // without blocking unrelated peers.
  private signalQueues = new Map<ClientID, Promise<void>>();

  constructor(
    private readonly myId: ClientID,
    private readonly send: (to: ClientID, data: string) => void,
    private readonly onConnectionFailed?: (peer: ClientID) => void,
  ) {
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(
      `[phone] PhoneTransport constructed myId=${JSON.stringify(this.myId)}`,
    );
  }

  get micDenied(): boolean {
    return this._micDenied;
  }

  // Bringt das Mesh auf den Stand der Teilnehmerliste: neue Peers aufbauen,
  // verschwundene abbauen.
  async syncPeers(peers: ClientID[]): Promise<void> {
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(
      `[phone] syncPeers called incoming=${JSON.stringify(peers)} currentPeerKeys=${JSON.stringify([...this.peers.keys()])}`,
    );
    const wanted = new Set(peers);
    for (const [id, peer] of [...this.peers]) {
      if (wanted.has(id)) continue;
      peer.audio.detach();
      peer.pc.close();
      this.peers.delete(id);
      this.signalQueues.delete(id);
    }
    if (peers.length === 0) {
      // TEMP diagnostics: remove once the phone audio bug is found
      console.log(
        `[phone] syncPeers taking EARLY RETURN (peers.length === 0) — stopping mic, no peer connection will be created`,
      );
      this.stopMic();
      return;
    }
    // Await the mic before creating any peer connection. If we don't,
    // createPeer() snapshots localStream while it's still null, the initial
    // offer goes out with zero audio tracks, and we're stuck relying on a
    // renegotiation round to fix it up after the fact. A resolved mic (or a
    // latched denial) guarantees createPeer() below always sees the right
    // state on the very first offer/answer.
    await this.ensureMic();
    for (const id of peers) {
      if (this.peers.has(id)) continue;
      const peer = await this.createPeer(id);
      // Nur eine Seite stellt das Offer, sonst kollidieren die Aufbauten.
      // Die kleinere ClientID gewinnt.
      if (this.myId < id) {
        await this.makeOffer(id, peer);
      }
    }
  }

  async handleSignal(from: ClientID, data: string): Promise<void> {
    // PhoneController fires one handleSignal() call per inbound WS message
    // with no await between them, so an offer and the candidates that
    // immediately follow it can otherwise race on the same RTCPeerConnection.
    // Chain onto the per-peer queue so they always run one at a time, in
    // arrival order, regardless of how fast the next message shows up.
    const prev = this.signalQueues.get(from) ?? Promise.resolve();
    const next = prev
      .catch(() => {
        // A prior message's rejection must not poison the queue for later
        // messages on the same peer.
      })
      .then(() => this.processSignal(from, data));
    this.signalQueues.set(from, next);
    return next;
  }

  private async processSignal(from: ClientID, data: string): Promise<void> {
    let msg: { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(
      `[phone] handleSignal inbound type=${msg.type} from=${from} dataLength=${data.length}`,
    );
    // Await the mic before creating a peer from an inbound offer/candidate,
    // same reasoning as syncPeers: createPeer() must see a resolved (or
    // denied) localStream so createAnswer() below reflects our real audio
    // state on the first round, instead of answering silent and needing a
    // second negotiation to add the track.
    await this.ensureMic();
    const peer = this.peers.get(from) ?? (await this.createPeer(from));
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(
      `[phone] handleSignal BEFORE type=${msg.type} from=${from} signalingState=${peer.pc.signalingState} connectionState=${peer.pc.connectionState}`,
    );
    try {
      if (msg.type === "offer") {
        await peer.pc.setRemoteDescription({
          type: "offer",
          sdp: msg.sdp,
        });
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        // TEMP diagnostics: remove once the phone audio bug is found
        console.log(
          `[phone] sending ANSWER to=${from} sdpLength=${answer.sdp?.length ?? 0}`,
        );
        this.send(from, JSON.stringify({ type: "answer", sdp: answer.sdp }));
      } else if (msg.type === "answer") {
        await peer.pc.setRemoteDescription({
          type: "answer",
          sdp: msg.sdp,
        });
      } else if (msg.type === "candidate" && msg.candidate) {
        await peer.pc.addIceCandidate(msg.candidate);
      }
    } catch (err) {
      console.error("PhoneTransport: signaling failed", err);
    }
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(
      `[phone] handleSignal AFTER type=${msg.type} from=${from} signalingState=${peer.pc.signalingState} connectionState=${peer.pc.connectionState}`,
    );
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  setVolume(v: number): void {
    this.volume = v;
    for (const peer of this.peers.values()) peer.audio.setVolume(v);
  }

  teardown(): void {
    for (const peer of this.peers.values()) {
      peer.audio.detach();
      peer.pc.close();
    }
    this.peers.clear();
    this.signalQueues.clear();
    this.stopMic();
  }

  private async createPeer(id: ClientID): Promise<Peer> {
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(
      `[phone] createPeer constructing RTCPeerConnection for id=${id}`,
    );
    const pc = new RTCPeerConnection({
      iceServers: await buildIceServers(this.myId),
      ...(ClientEnv.phoneTurnForceRelay()
        ? { iceTransportPolicy: "relay" as RTCIceTransportPolicy }
        : {}),
    });
    const audio = new PhoneAudio();
    audio.setVolume(this.volume);

    for (const track of this.localStream?.getAudioTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      this.send(
        id,
        JSON.stringify({ type: "candidate", candidate: e.candidate.toJSON() }),
      );
    };
    pc.ontrack = (e) => {
      // TEMP diagnostics: remove once the phone audio bug is found
      console.log(
        `[phone] ontrack fired for id=${id} streamCount=${e.streams.length}`,
      );
      if (e.streams[0]) audio.attach(e.streams[0]);
    };
    // "disconnected" is often a transient blip (brief ICE hiccup) that
    // recovers on its own; only "failed" means ICE genuinely could not find
    // a working path (STUN-only, and no TURN configured, or TURN itself is
    // unreachable) — players get an honest "no connection" instead of
    // endless ringing.
    pc.onconnectionstatechange = () => {
      // TEMP diagnostics: remove once the phone audio bug is found
      console.log(
        `[phone] connectionState changed for id=${id} -> ${pc.connectionState}`,
      );
      if (pc.connectionState === "failed") {
        this.onConnectionFailed?.(id);
      }
    };

    const peer = { pc, audio };
    this.peers.set(id, peer);
    return peer;
  }

  private async makeOffer(id: ClientID, peer: Peer): Promise<void> {
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(
      `[phone] makeOffer to id=${id} myId=${JSON.stringify(this.myId)} myId<id=${this.myId < id}`,
    );
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.send(id, JSON.stringify({ type: "offer", sdp: offer.sdp }));
    } catch (err) {
      console.error("PhoneTransport: failed to offer", err);
    }
  }

  // Holt das Mikrofon beim ersten Bedarf. Wird es verweigert, bleibt das
  // Telefon nutzbar: man hört die anderen, sendet aber nichts.
  //
  // Idempotent under concurrency: syncPeers() and handleSignal() can both
  // call this around the same time (e.g. an incoming offer arrives while we
  // are also spinning up our own peers). Without a shared in-flight promise,
  // each caller would see localStream === null and fire its own
  // getUserMedia(), producing duplicate permission prompts/streams.
  private async ensureMic(): Promise<void> {
    if (this.localStream || this._micDenied) return;
    if (this.micPromise) return this.micPromise;
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(`[phone] ensureMic starting getUserMedia()`);
    this.micPromise = (async () => {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        // TEMP diagnostics: remove once the phone audio bug is found
        console.log(
          `[phone] ensureMic success trackCount=${this.localStream.getAudioTracks().length}`,
        );
        this.setMuted(this.muted);
      } catch {
        // TEMP diagnostics: remove once the phone audio bug is found
        console.log(`[phone] ensureMic DENIED`);
        this._micDenied = true;
      } finally {
        this.micPromise = null;
      }
    })();
    return this.micPromise;
  }

  private stopMic(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
}
