import type { ClientID } from "../../core/Schemas";
import { PhoneAudio } from "./PhoneAudio";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

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

  constructor(
    private readonly myId: ClientID,
    private readonly send: (to: ClientID, data: string) => void,
    private readonly onConnectionFailed?: (peer: ClientID) => void,
  ) {}

  get micDenied(): boolean {
    return this._micDenied;
  }

  // Bringt das Mesh auf den Stand der Teilnehmerliste: neue Peers aufbauen,
  // verschwundene abbauen.
  async syncPeers(peers: ClientID[]): Promise<void> {
    const wanted = new Set(peers);
    for (const [id, peer] of [...this.peers]) {
      if (wanted.has(id)) continue;
      peer.audio.detach();
      peer.pc.close();
      this.peers.delete(id);
    }
    if (peers.length === 0) {
      this.stopMic();
      return;
    }
    // Do not block peer/offer creation on the mic (see handleSignal for the
    // same reasoning) — start the request in the background and let
    // attachMicToExistingPeers()/onnegotiationneeded carry the track across
    // once it resolves, however long that takes.
    void this.ensureMic();
    for (const id of peers) {
      if (this.peers.has(id)) continue;
      const peer = this.createPeer(id);
      // Nur eine Seite stellt das Offer, sonst kollidieren die Aufbauten.
      // Die kleinere ClientID gewinnt.
      if (this.myId < id) {
        await this.makeOffer(id, peer);
      }
    }
  }

  async handleSignal(from: ClientID, data: string): Promise<void> {
    let msg: { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    // Do not block peer creation / signaling on the mic: getUserMedia() can
    // take seconds (permission prompt), and an incoming offer/candidate
    // must not be delayed by it. Kick off ensureMic() in the background —
    // once it resolves, attachMicToExistingPeers() tops up this (and any
    // other) connection and onnegotiationneeded carries the track across.
    void this.ensureMic();
    const peer = this.peers.get(from) ?? this.createPeer(from);
    try {
      if (msg.type === "offer") {
        await peer.pc.setRemoteDescription({
          type: "offer",
          sdp: msg.sdp,
        });
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
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
    this.stopMic();
  }

  private createPeer(id: ClientID): Peer {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
      if (e.streams[0]) audio.attach(e.streams[0]);
    };
    // Fires whenever tracks are added/removed after the initial handshake
    // (e.g. the mic arriving late, see attachMicToExistingPeers). Both sides
    // get this event, which would normally cause an offer collision — two
    // simultaneous re-offers stomping on each other's signalingState. We
    // apply the same "smaller id offers" rule used for the initial offer
    // (see syncPeers) so only one side of any given pair ever re-offers.
    //
    // The other (higher-id) side still needs its new track to reach the
    // peer: it doesn't send its own offer, but the moment it becomes the
    // *answerer* of the lower side's renegotiation offer, its up-to-date
    // set of senders (including the newly added track) is included in that
    // answer automatically — createAnswer() always reflects the current
    // local senders, not just the ones present at the original offer. So
    // the lower-id side's onnegotiationneeded re-offer is what carries
    // audio for *both* directions once handleSignal() answers it.
    //
    // Guard with signalingState === "stable" so an already-in-flight
    // negotiation (or a race where onnegotiationneeded fires again before
    // the previous round finished) doesn't double-offer and corrupt state.
    pc.onnegotiationneeded = () => {
      if (this.myId >= id) return;
      if (pc.signalingState !== "stable") return;
      void this.makeOffer(id, peer);
    };
    // "disconnected" is often a transient blip (brief ICE hiccup) that
    // recovers on its own; only "failed" means STUN-only connectivity has
    // genuinely broken down (see design spec: no TURN server in v1, so
    // players behind strict NATs get an honest "no connection" instead of
    // endless ringing).
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.onConnectionFailed?.(id);
      }
    };

    const peer = { pc, audio };
    this.peers.set(id, peer);
    return peer;
  }

  private async makeOffer(id: ClientID, peer: Peer): Promise<void> {
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
    this.micPromise = (async () => {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        this.setMuted(this.muted);
        this.attachMicToExistingPeers();
      } catch {
        this._micDenied = true;
      } finally {
        this.micPromise = null;
      }
    })();
    return this.micPromise;
  }

  // Once the mic arrives, top up any connection that was created before it
  // resolved (createPeer() only adds tracks that exist at that instant).
  // getSenders() is the source of truth rather than a separately tracked
  // flag, so this stays correct even if createPeer's own snapshot logic
  // changes.
  private attachMicToExistingPeers(): void {
    if (!this.localStream) return;
    const [track] = this.localStream.getAudioTracks();
    if (!track) return;
    for (const peer of this.peers.values()) {
      const hasAudioSender = peer.pc
        .getSenders()
        .some((s) => s.track?.kind === "audio");
      if (hasAudioSender) continue;
      peer.pc.addTrack(track, this.localStream);
    }
  }

  private stopMic(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
}
