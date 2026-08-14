import type {
  ClientID,
  ClientPhonePayload,
  ServerPhonePayload,
} from "../../core/Schemas";
import { type Call, defaultPrefs, type PhonePrefs } from "./PhoneTypes";

export const MAX_CALL_PARTICIPANTS = 6;
export const RING_TIMEOUT_MS = 12000;
// Harte Obergrenze für die GESPRÄCHSZEIT eines Calls. Läuft serverseitig,
// getrieben von derselben tick()-Sweep wie die Klingel-Timeouts — kein
// setTimeout, keine Client-Uhr. Ein Countdown, der dem Client gehört, ist mit
// einem veränderten Client einfach abgeschaltet; diese Frist nicht.
export const MAX_CALL_MS = 120000;
// Wie lange dasselbe PAAR nach einem abgelaufenen Gespräch warten muss, bevor
// es sich erneut anrufen darf. Bewusst paarweise und nicht pro Spieler: eine
// Sperre am Spieler wäre eine Waffe — man ruft einen Rivalen an, lässt die
// Zeit auslaufen und hat ihm sein Telefon für alle abgedreht.
export const REDIAL_COOLDOWN_MS = 30000;

export interface PhoneParticipant {
  clientID: ClientID;
  username: string;
  isAllyOf(other: ClientID): boolean;
}

export type PhoneOutbox = { to: ClientID; payload: ServerPhonePayload };

// Ungeordneter Schlüssel für ein Spielerpaar: A|B und B|A müssen denselben
// Eintrag treffen, sonst wäre die Sperre einseitig und der Zurückruf ginge
// durch.
function pairKey(a: ClientID, b: ClientID): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class PhoneExchange {
  private players = new Map<ClientID, PhoneParticipant>();
  private prefs = new Map<ClientID, PhonePrefs>();
  private calls = new Map<string, Call>();
  // Wo steckt ein Spieler gerade: verbunden ODER klingelnd.
  private callOf = new Map<ClientID, string>();
  // Wer im Match gestorben ist. Anders als removePlayer ist das endgültig:
  // ein Toter bleibt tot, auch wenn seine Socket neu verbindet (er schaut ja
  // weiter zu). Deshalb überlebt dieser Eintrag addPlayer.
  private dead = new Set<ClientID>();
  // Paare, die gerade nicht miteinander telefonieren dürfen, weil ihr
  // gemeinsames Gespräch am Zeitlimit gestorben ist. Schlüssel ist das
  // ungeordnete Paar (siehe pairKey), der Wert der Ablaufzeitpunkt.
  //
  // Warum am PAAR und nicht am Spieler: eine Sperre pro Spieler ließe sich
  // gegen ihn verwenden — anrufen, auslaufen lassen, fertig, der andere ist
  // 30 Sekunden für jeden unerreichbar. So trifft die Wartezeit nur genau die
  // Verbindung, die eben schon zwei Minuten hatte; beide bleiben für alle
  // anderen sofort erreichbar. Wie prefs überlebt das absichtlich
  // removePlayer: eine Sperre, die man durch Socket-Wackeln loswird, ist
  // keine.
  private cooldowns = new Map<string, number>();
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
      case "reject":
        // Aktives Abweisen. Für einen noch klingelnden Ruf ist das exakt der
        // Ablehnungs-Zweig von leaveCall: der Anrufer hört Besetzt, beim
        // Abweisenden landet kein verpasster Anruf. Sitzt der Absender schon
        // verbunden im Call, ist "reject" bedeutungslos und verhält sich wie
        // hangup — er verlässt nur sich selbst, wirft nie jemanden raus.
        return this.leaveCall(from, { missedForCaller: false });
      case "hangup":
        return this.leaveCall(from, { missedForCaller: true });
      case "died":
        // NUR über den Absender. `from` kommt aus der Verbindung, niemals aus
        // der Nutzlast — sonst könnte ein manipulierter Client fremde Calls
        // beenden oder Rivalen aus einer Konferenz werfen.
        return this.markDead(from);
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
        // Überlebt der Call (Konferenz), erfahren die Verbliebenen, dass der
        // ausstehende Ruf weg ist — sonst bliebe er ewig als "klingelt" stehen.
        if (this.calls.has(call.id)) out.push(...this.broadcastState(call));
      }
      // Zeitlimit. Erst NACH den Klingel-Timeouts geprüft, und nur für Calls,
      // die es noch gibt: ein Ruf, der oben schon zusammengefallen ist, darf
      // nicht ein zweites Mal abgeräumt werden.
      if (!this.calls.has(call.id)) continue;
      if (call.expiresAt === null || t < call.expiresAt) continue;
      out.push(...this.expireCall(call));
    }
    // Abgelaufene Sperren aufräumen, damit die Map nicht über ein langes Match
    // mitwächst. Rein hygienisch — geprüft wird in dial() ohnehin gegen die
    // Uhr, ein noch nicht weggeräumter Eintrag sperrt also nichts mehr.
    for (const [key, until] of this.cooldowns) {
      if (t >= until) this.cooldowns.delete(key);
    }
    return out;
  }

  // Der Call hat seine zwei Minuten aufgebraucht. Anders als ein Auflegen
  // trifft das ALLE gleichzeitig, und nur hier entstehen Sperren.
  private expireCall(call: Call): PhoneOutbox[] {
    const out: PhoneOutbox[] = [];
    // Alle Paare, die in DIESEM Moment tatsächlich miteinander verbunden
    // waren, müssen warten. Nur A|B zu sperren würde nichts bringen: die
    // beiden formten dieselbe Runde sofort über C neu, und das Limit wäre
    // eine Formalie. Wer vorher aufgelegt hat, ist hier nicht mehr in
    // `participants` — der wurde nicht abgeschnitten, sondern ist gegangen,
    // und schleppt darum auch keine Sperre mit.
    const connected = [...call.participants];
    const until = this.now() + REDIAL_COOLDOWN_MS;
    for (let i = 0; i < connected.length; i++) {
      for (let j = i + 1; j < connected.length; j++) {
        this.cooldowns.set(pairKey(connected[i], connected[j]), until);
      }
    }

    for (const p of connected) {
      this.callOf.delete(p);
      out.push({ to: p, payload: { kind: "callEnded", callId: call.id } });
    }
    // Wer beim Ablauf noch klingelte, hat nie mit jemandem gesprochen: der
    // bekommt einen verpassten Anruf und bleibt ohne Sperre erreichbar.
    for (const [target, r] of call.ringing) {
      this.callOf.delete(target);
      out.push(...this.missedFor(target, r.from));
    }
    this.destroyCall(call);
    return out;
  }

  // Der Tod beendet die Teilnahme am Telefonnetz — aber nur die eigene.
  //
  // Bewusst anders als removePlayer: dort ist der Spieler nur weg vom Draht
  // und kommt womöglich gleich wieder (deshalb überleben dort die Prefs, und
  // deshalb ist der Zustand dort umkehrbar). Der Tod ist im Match endgültig:
  // der Spieler bleibt verbunden und schaut zu, ist aber nie wieder
  // anrufbar. Was beide teilen: Prefs (DND/Block) bleiben unangetastet — sie
  // gehören dem Client, nicht seiner Lebendigkeit. Sie zu löschen wäre
  // derselbe Fehler wie damals beim Verbindungsabbruch.
  private markDead(who: ClientID): PhoneOutbox[] {
    if (this.dead.has(who)) return [];
    this.dead.add(who);
    // Laufender Ruf oder laufendes Gespräch endet — wie ein Auflegen, damit
    // ein noch klingelndes Ziel nicht ewig weiterklingelt.
    return this.leaveCall(who, { missedForCaller: true });
  }

  private dial(from: ClientID, target: ClientID): PhoneOutbox[] {
    const busy: PhoneOutbox[] = [{ to: from, payload: { kind: "busy" } }];

    if (target === from) return busy;
    const targetPlayer = this.players.get(target);
    if (!targetPlayer) return busy;
    if (!this.players.has(from)) return busy;
    // Tote telefonieren nicht — weder raus noch rein. Nach außen dasselbe
    // Besetztzeichen wie jede andere Ablehnung, damit sich daran nichts
    // ablesen lässt.
    if (this.dead.has(from) || this.dead.has(target)) return busy;
    // Das Ziel darf nirgends stecken — weder verbunden noch angeklingelt.
    if (this.callOf.has(target)) return busy;
    // Frisch abgelaufenes Gespräch mit genau diesem Gegenüber: Wartezeit.
    // Dasselbe nackte Besetztzeichen wie DND/Block/Abweisen — der Anrufer
    // darf den Grund nicht unterscheiden können (Design-Spec: "Bei jedem
    // Nein bekommt der Anrufer dasselbe Besetztzeichen").
    if (this.onCooldown(from, target)) return busy;

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

    // `callOf` holds both connected participants and ringing targets. Only
    // an actual, already-connected participant of an existing call may pull
    // in a third party. Being a bare entry in `callOf` is not enough:
    //   - a player who is only ringing as someone else's dial target has
    //     not consented to anything beyond that one pending call, and
    //   - a player whose OWN outgoing dial is still unanswered is, from
    //     `from`'s own call's point of view, the sole participant sitting
    //     alone with a pending ring — not yet connected to anyone.
    // Both must be rejected: `call.participants` must contain `from` AND
    // at least one other member for the call to count as "connected" and
    // therefore joinable. (callOf is single-valued, so letting either case
    // through would try to place `from` in two calls at once and corrupt
    // state.) Such a dial is rejected as busy, same as any other rejection.
    const existingId = this.callOf.get(from);
    const existingCall = existingId ? this.calls.get(existingId) : undefined;
    const existing =
      existingCall &&
      existingCall.participants.has(from) &&
      existingCall.participants.size >= 2
        ? existingId
        : undefined;
    if (existingId && !existing) return busy;
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
      // Genau wie ein Block gilt die Wartezeit gegenüber JEDEM im Call, sonst
      // wäre sie über den Umweg Konferenz umgangen: A holt C dazu, C holt B
      // dazu, und A sitzt wieder mit B in derselben Leitung.
      if (this.onCooldown(target, peer)) return busy;
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
    const out: PhoneOutbox[] = [
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
    // Beim Dazuwählen sitzen schon Leute im Call: die müssen den neuen
    // ausstehenden Ruf sehen. Beim ersten Anruf ist der Anrufer allein, dann
    // sagt "dialing" allein schon alles.
    if (existing) out.push(...this.broadcastState(call));
    return out;
  }

  private answer(who: ClientID): PhoneOutbox[] {
    const callId = this.callOf.get(who);
    if (!callId) return [];
    const call = this.calls.get(callId);
    if (!call?.ringing.has(who)) return [];

    call.ringing.delete(who);
    call.participants.add(who);
    // Hier — und nur hier — startet die Gesprächsuhr: beim ERSTEN Annehmen,
    // wenn aus dem Klingeln ein Gespräch wird. Nicht beim Anlegen des Calls,
    // sonst zöge ein Ziel, das zehn Sekunden klingeln lässt, dem Gespräch
    // fast ein Zehntel seiner Zeit ab, bevor jemand ein Wort gesagt hat — und
    // ein Anrufer könnte die Redezeit eines anderen allein durch frühes
    // Wählen verkürzen. Das `??=` macht es zum Einmal-Ereignis: der Zweite und
    // Dritte einer Konferenz erben die schon laufende Frist, das Limit gehört
    // dem Call und nicht der Person.
    call.expiresAt ??= this.now() + MAX_CALL_MS;
    return this.broadcastState(call);
  }

  // Steht dieses Paar gerade unter Wartezeit? Gegen die Uhr geprüft, nicht
  // gegen bloßes Vorhandensein: der Aufräumer in tick() darf für die
  // Korrektheit nicht zuständig sein.
  private onCooldown(a: ClientID, b: ClientID): boolean {
    const until = this.cooldowns.get(pairKey(a, b));
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.cooldowns.delete(pairKey(a, b));
      return false;
    }
    return true;
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
      // War es eine Konferenz, bleibt sie bestehen — nur der ausstehende Ruf
      // fällt weg, und das müssen die Verbliebenen sehen.
      if (this.calls.has(call.id)) out.push(...this.broadcastState(call));
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
    // Klingelnde Ziele gehören dem Call, nicht dem Anwählenden — deshalb
    // sehen sie alle Verbundenen. Der Client braucht das doppelt: um
    // "verbunden" von "klingelt noch" zu unterscheiden, und um zu wissen,
    // dass er weiterhin in einem Gespräch sitzt, während ein neuer Ruf
    // rausgeht (sonst verschwindet dort die Auflegen-Taste).
    const ringing = [...call.ringing.keys()];
    // Restzeit als DAUER, nicht als Zeitstempel: die Uhren von Server und
    // Client sind nicht synchron, ein roher Deadline stünde beim Empfänger
    // daneben. Der Client heftet die Dauer einmal an seine eigene Uhr. Sie
    // reist mit jedem callState mit, damit ein später Dazugekommener
    // dieselbe Zahl sieht und kein Countdown auseinanderläuft. Vor dem ersten
    // Annehmen läuft noch keine Frist — dann bleibt das Feld weg.
    const remainingMs =
      call.expiresAt === null
        ? undefined
        : Math.max(0, call.expiresAt - this.now());
    return [...call.participants].map((p) => ({
      to: p,
      payload: {
        kind: "callState" as const,
        callId: call.id,
        peers: [...call.participants].filter((x) => x !== p),
        ringing,
        remainingMs,
      },
    }));
  }

  private createCall(initiator: ClientID): Call {
    const call: Call = {
      id: `call-${this.nextCallId++}`,
      participants: new Set([initiator]),
      ringing: new Map(),
      // Noch keine Frist: es klingelt erst. Gesetzt wird sie beim ersten
      // answer(), damit Klingelzeit keine Gesprächszeit frisst.
      expiresAt: null,
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
