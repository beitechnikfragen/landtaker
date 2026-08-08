import type {
  ClientID,
  ClientPhonePayload,
  ServerPhonePayload,
} from "../../core/Schemas";
import { type Call, defaultPrefs, type PhonePrefs } from "./PhoneTypes";

export const MAX_CALL_PARTICIPANTS = 6;
export const RING_TIMEOUT_MS = 12000;

export interface PhoneParticipant {
  clientID: ClientID;
  username: string;
  isAllyOf(other: ClientID): boolean;
}

export type PhoneOutbox = { to: ClientID; payload: ServerPhonePayload };

export class PhoneExchange {
  private players = new Map<ClientID, PhoneParticipant>();
  private prefs = new Map<ClientID, PhonePrefs>();
  private calls = new Map<string, Call>();
  // Wo steckt ein Spieler gerade: verbunden ODER klingelnd.
  private callOf = new Map<ClientID, string>();
  private nextCallId = 1;

  constructor(private readonly now: () => number) {}

  addPlayer(p: PhoneParticipant): void {
    this.players.set(p.clientID, p);
    if (!this.prefs.has(p.clientID)) {
      this.prefs.set(p.clientID, defaultPrefs());
    }
  }

  removePlayer(clientID: ClientID): PhoneOutbox[] {
    this.players.delete(clientID);
    const out = this.leaveCall(clientID, { missedForCaller: false });
    // Prefs (mode, alliesOnly, blocked) deliberately outlive this: a socket
    // drop is not the end of the match, and GameServer calls removePlayer on
    // every disconnect — including brief ones expected to reconnect via
    // addPlayer. Wiping prefs here would silently turn DND off and, worse,
    // drop blocks (a safety control) on every network blip. Prefs are small
    // and bounded by the match; the whole PhoneExchange is discarded when the
    // game ends, so there is nothing else to clean up.
    return out;
  }

  handle(from: ClientID, payload: ClientPhonePayload): PhoneOutbox[] {
    const prefs = this.prefsOf(from);
    switch (payload.kind) {
      case "setMode":
        prefs.mode = payload.mode;
        return [];
      case "setAlliesOnly":
        prefs.alliesOnly = payload.value;
        return [];
      case "block":
        prefs.blocked.add(payload.target);
        return [];
      case "unblock":
        prefs.blocked.delete(payload.target);
        return [];
      case "dial":
        return this.dial(from, payload.target);
      case "answer":
        return this.answer(from);
      case "hangup":
        return this.leaveCall(from, { missedForCaller: true });
      case "signal":
        return this.forwardSignal(from, payload.to, payload.data);
    }
  }

  tick(): PhoneOutbox[] {
    const out: PhoneOutbox[] = [];
    const t = this.now();
    for (const call of [...this.calls.values()]) {
      for (const [target, ring] of [...call.ringing]) {
        if (t < ring.expiresAt) continue;
        call.ringing.delete(target);
        this.callOf.delete(target);
        out.push(...this.missedFor(target, ring.from));
        out.push(...this.collapseIfEmpty(call));
      }
    }
    return out;
  }

  private dial(from: ClientID, target: ClientID): PhoneOutbox[] {
    const busy: PhoneOutbox[] = [{ to: from, payload: { kind: "busy" } }];

    if (target === from) return busy;
    const targetPlayer = this.players.get(target);
    if (!targetPlayer) return busy;
    if (!this.players.has(from)) return busy;
    // Das Ziel darf nirgends stecken — weder verbunden noch angeklingelt.
    if (this.callOf.has(target)) return busy;

    const targetPrefs = this.prefsOf(target);
    if (targetPrefs.mode === "dnd") return busy;
    if (targetPrefs.blocked.has(from)) return busy;
    if (
      targetPrefs.alliesOnly &&
      !targetPlayer.isAllyOf(from) &&
      !this.players.get(from)?.isAllyOf(target)
    ) {
      return busy;
    }

    const existing = this.callOf.get(from);
    const call = existing ? this.calls.get(existing)! : this.createCall(from);

    // Blocks gelten gegenüber JEDEM Teilnehmer — auch gegenüber noch
    // klingelnden (nicht angenommenen) Rufen, sonst wäre der Block über den
    // Umweg Konferenz umgehbar.
    const others = new Set<ClientID>([
      ...call.participants,
      ...call.ringing.keys(),
    ]);
    for (const peer of others) {
      if (peer === from) continue;
      if (targetPrefs.blocked.has(peer)) return busy;
      if (this.prefsOf(peer).blocked.has(target)) return busy;
    }

    const projected = call.participants.size + call.ringing.size + 1;
    if (projected > MAX_CALL_PARTICIPANTS) {
      if (!existing) this.destroyCall(call);
      return busy;
    }

    call.ringing.set(target, {
      from,
      expiresAt: this.now() + RING_TIMEOUT_MS,
    });
    this.callOf.set(target, call.id);

    const caller = this.players.get(from)!;
    return [
      {
        to: target,
        payload: {
          kind: "ringing",
          callId: call.id,
          from,
          fromUsername: caller.username,
        },
      },
      { to: from, payload: { kind: "dialing", callId: call.id } },
    ];
  }

  private answer(who: ClientID): PhoneOutbox[] {
    const callId = this.callOf.get(who);
    if (!callId) return [];
    const call = this.calls.get(callId);
    if (!call?.ringing.has(who)) return [];

    call.ringing.delete(who);
    call.participants.add(who);
    return this.broadcastState(call);
  }

  private leaveCall(
    who: ClientID,
    opts: { missedForCaller: boolean },
  ): PhoneOutbox[] {
    const callId = this.callOf.get(who);
    if (!callId) return [];
    const call = this.calls.get(callId);
    if (!call) {
      this.callOf.delete(who);
      return [];
    }
    this.callOf.delete(who);

    const out: PhoneOutbox[] = [];

    // Fall 1: Der Gerufene weist ab -> der Rufende hört Besetzt, kein
    // verpasster Anruf beim Abweisenden.
    const ring = call.ringing.get(who);
    if (ring) {
      call.ringing.delete(who);
      if (call.participants.has(ring.from) && call.participants.size === 1) {
        out.push({ to: ring.from, payload: { kind: "busy" } });
      }
      out.push(...this.collapseIfEmpty(call));
      return out;
    }

    // Fall 2: Ein Verbundener legt auf.
    call.participants.delete(who);
    out.push({ to: who, payload: { kind: "callEnded", callId: call.id } });

    // Rufe, die dieser Spieler ausgelöst hat, laufen weiter — sie gelten dem
    // Call, nicht der Person. Nur wenn der Call komplett endet, brechen sie ab.
    if (opts.missedForCaller && call.participants.size === 0) {
      for (const [target, r] of [...call.ringing]) {
        call.ringing.delete(target);
        this.callOf.delete(target);
        out.push(...this.missedFor(target, r.from));
      }
    }

    out.push(...this.collapseIfEmpty(call));
    if (this.calls.has(call.id)) {
      out.push(...this.broadcastState(call));
    }
    return out;
  }

  private collapseIfEmpty(call: Call): PhoneOutbox[] {
    if (call.participants.size + call.ringing.size >= 2) return [];
    const out: PhoneOutbox[] = [];
    for (const p of call.participants) {
      this.callOf.delete(p);
      out.push({ to: p, payload: { kind: "callEnded", callId: call.id } });
    }
    for (const [target, r] of call.ringing) {
      this.callOf.delete(target);
      out.push(...this.missedFor(target, r.from));
    }
    this.destroyCall(call);
    return out;
  }

  private missedFor(target: ClientID, from: ClientID): PhoneOutbox[] {
    const caller = this.players.get(from);
    const out: PhoneOutbox[] = [];
    if (caller) {
      out.push({
        to: target,
        payload: {
          kind: "missed",
          from,
          fromUsername: caller.username,
        },
      });
    }
    return out;
  }

  private forwardSignal(
    from: ClientID,
    to: ClientID,
    data: string,
  ): PhoneOutbox[] {
    const callId = this.callOf.get(from);
    if (!callId || this.callOf.get(to) !== callId) return [];
    return [{ to, payload: { kind: "signal", from, data } }];
  }

  private broadcastState(call: Call): PhoneOutbox[] {
    return [...call.participants].map((p) => ({
      to: p,
      payload: {
        kind: "callState" as const,
        callId: call.id,
        peers: [...call.participants].filter((x) => x !== p),
      },
    }));
  }

  private createCall(initiator: ClientID): Call {
    const call: Call = {
      id: `call-${this.nextCallId++}`,
      participants: new Set([initiator]),
      ringing: new Map(),
    };
    this.calls.set(call.id, call);
    this.callOf.set(initiator, call.id);
    return call;
  }

  private destroyCall(call: Call): void {
    // Idempotent: only clear a callOf entry if it still points at this call —
    // callers may have already been cleaned up (collapseIfEmpty) or moved on
    // to a different call by the time this runs.
    for (const p of call.participants) {
      if (this.callOf.get(p) === call.id) this.callOf.delete(p);
    }
    for (const target of call.ringing.keys()) {
      if (this.callOf.get(target) === call.id) this.callOf.delete(target);
    }
    this.calls.delete(call.id);
  }

  private prefsOf(clientID: ClientID): PhonePrefs {
    let p = this.prefs.get(clientID);
    if (!p) {
      p = defaultPrefs();
      this.prefs.set(clientID, p);
    }
    return p;
  }
}
