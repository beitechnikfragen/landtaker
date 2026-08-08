# Telefonsystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-Match-Telefonsystem mit echtem WebRTC-Voice, diegetischem Wählscheiben-Telefon, Erreichbarkeits-Modi (Normal/Lautlos/DND), Mesh-Konferenzen bis sechs Teilnehmer und verpassten Anrufen.

**Architecture:** Signaling läuft als eigene Zod-validierte Message-Familie über die bestehende Game-WebSocket, bewusst **außerhalb** der Intent/Turn-Pipeline — `src/core/` bleibt unangetastet, weil Anrufe kein deterministischer Spielzustand sind. Serverseitig entscheidet eine `PhoneExchange` (Vermittlungsstelle) allein über Durchstellen/Besetzt. Clientseitig sind Zustandsautomat (reine Logik), WebRTC-Transport und Lit-UI strikt getrennt.

**Tech Stack:** TypeScript 5.7, Zod, Vitest, WebRTC (`RTCPeerConnection`), Web Audio API, Lit + Tailwind 4, Howler.js, ws (Server).

**Spec:** `docs/superpowers/specs/2026-08-08-telefonsystem-design.md`

## Global Constraints

- **`src/core/game/` und die Simulation werden NICHT angefasst.** Telefon-Nachrichten werden niemals zu Intents und niemals in einen Turn gepackt. Einzige erlaubte Änderung unter `src/core/`: neue Schemas in `Schemas.ts` und ein Getter/Setter-Block in `game/UserSettings.ts`.
- **Klingel-Timeout: 12000 ms.** Als exportierte Konstante `RING_TIMEOUT_MS`, nicht als Literal an mehreren Stellen.
- **Maximale Call-Größe: 6 Teilnehmer.** Als exportierte Konstante `MAX_CALL_PARTICIPANTS`.
- **Ein einziger Ablehnungsgrund nach außen:** Jede fehlgeschlagene Prüfung führt zu exakt derselben Nachricht an den Anrufer (`"busy"`). Nie den echten Grund an den Client senden — sonst lässt sich Block/DND durch Ausprobieren unterscheiden.
- **Alle Erreichbarkeitsprüfungen passieren serverseitig** in `PhoneExchange`. Der Client darf DND/Block nie selbst durchsetzen.
- **Keine Aufzeichnung.** Kein Audio-Pfad über den Server, kein `MediaRecorder`, nirgends.
- **Telefon-Bandpass:** Hochpass 300 Hz, Tiefpass 3400 Hz, beides `Q = 0.9`, danach `DynamicsCompressor` und `WaveShaper`-Sättigung.
- **i18n:** Jeder sichtbare Text über `translateText()` mit Eintrag in `resources/lang/en.json`. Keine andere Sprachdatei anfassen (Crowdin).
- **Tests:** `npx vitest tests/<Datei>.test.ts --run`. Vor jedem Commit `npm run format`.
- Prettier läuft als Pre-Commit-Hook. `node_modules` muss vorhanden sein (`npm run inst`), sonst schlägt jeder Commit fehl.

## File Structure

**Neu — Server:**

- `src/server/phone/PhoneExchange.ts` — Vermittlungsstelle: Calls, Modi, Blocks, Prüfkette. Reine Logik, kein WebSocket.
- `src/server/phone/PhoneTypes.ts` — interne Server-Typen (`CallId`, `Call`, `PhonePrefs`).

**Neu — Client:**

- `src/client/phone/CallStateMachine.ts` — Zustandsautomat, kennt weder WebRTC noch DOM.
- `src/client/phone/PhoneAudio.ts` — Web-Audio-Kette (Bandpass/Kompressor/Sättigung) pro Teilnehmer.
- `src/client/phone/PhoneTransport.ts` — `RTCPeerConnection`-Verwaltung, Mikrofon, Mesh.
- `src/client/phone/PhoneController.ts` — verdrahtet Automat + Transport + Netzwerk-Nachrichten.
- `src/client/phone/PhoneSounds.ts` — loopende Telefon-Geräusche (Howler, eigener Volume-Regler).
- `src/client/hud/layers/PhoneWidget.ts` — Lit-Komponente: Apparat, Anruferliste, Drehschalter, Notizblock.

**Geändert:**

- `src/core/Schemas.ts` — Telefon-Message-Schemas, in `ClientMessageSchema`/`ServerMessageSchema` aufgenommen.
- `src/core/game/UserSettings.ts` — Modus, Verbündeten-Filter, Telefon-Lautstärke.
- `src/server/ClientMsgRateLimiter.ts` — eigenes Limit für Telefon-Nachrichten.
- `src/server/GameServer.ts` — Nachrichten an `PhoneExchange` reichen, Ausgaben zustellen, Disconnect melden.
- `src/client/Transport.ts` — Telefon-Nachrichten senden.
- `src/client/hud/GameRenderer.ts` — `PhoneWidget` und `PhoneController` verdrahten.
- `index.html` — `<phone-widget>` neben `<emoji-table>`.
- `resources/lang/en.json` — Texte.

**Tests (neu):**

- `tests/PhoneCallStateMachine.test.ts`
- `tests/server/PhoneExchange.test.ts`
- `tests/server/PhoneRateLimiter.test.ts`
- `tests/PhoneSchemas.test.ts`

---

### Task 1: Telefon-Schemas

Definiert die Wire-Formate. Alles Spätere hängt daran, deshalb zuerst.

**Files:**

- Modify: `src/core/Schemas.ts`
- Test: `tests/PhoneSchemas.test.ts`

**Interfaces:**

- Consumes: nichts.
- Produces: `ClientPhoneMessageSchema`, `ServerPhoneMessageSchema`, Typen `ClientPhoneMessage`, `ServerPhoneMessage`, `PhoneMode`, `CallId`. Aufgenommen in `ClientMessageSchema` (Typ `"phone"`) und `ServerMessageSchema` (Typ `"phone"`).

- [ ] **Step 1: Write the failing test**

Erstelle `tests/PhoneSchemas.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ClientMessageSchema, ServerMessageSchema } from "../src/core/Schemas";

describe("phone schemas", () => {
  it("accepts a dial message", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "dial", target: "abcd1234" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a mode change", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "setMode", mode: "dnd" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown mode", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "setMode", mode: "invisible" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an SDP signal with a bounded payload", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: {
        kind: "signal",
        to: "abcd1234",
        data: JSON.stringify({ type: "offer", sdp: "v=0" }),
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an oversized signal payload", () => {
    const result = ClientMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "signal", to: "abcd1234", data: "x".repeat(20001) },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a server ringing message", () => {
    const result = ServerMessageSchema.safeParse({
      type: "phone",
      payload: {
        kind: "ringing",
        callId: "call-1",
        from: "abcd1234",
        fromUsername: "Alice",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a server busy message", () => {
    const result = ServerMessageSchema.safeParse({
      type: "phone",
      payload: { kind: "busy" },
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest tests/PhoneSchemas.test.ts --run
```

Expected: FAIL — die Schemas kennen `type: "phone"` noch nicht.

- [ ] **Step 3: Add the schemas**

In `src/core/Schemas.ts`, direkt **vor** `export const ClientMessageSchema = z.discriminatedUnion(...)` (aktuell Zeile 911) einfügen:

```typescript
//
// Phone (out-of-band: never an Intent, never in a Turn)
//

// SDP-Offers/Answers sind die größten Nachrichten; ICE-Kandidaten sind winzig.
// 20 KB ist großzügig für ein SDP und schließt Fluten mit Riesen-Payloads aus.
const MAX_SIGNAL_BYTES = 20000;

export const PhoneModeSchema = z.enum(["normal", "silent", "dnd"]);
export type PhoneMode = z.infer<typeof PhoneModeSchema>;
export type CallId = string;

export const ClientPhonePayloadSchema = z.discriminatedUnion("kind", [
  // Ruft ein Ziel an: eröffnet einen Call oder holt in den eigenen dazu.
  z.object({ kind: z.literal("dial"), target: ID }),
  z.object({ kind: z.literal("answer") }),
  z.object({ kind: z.literal("hangup") }),
  z.object({ kind: z.literal("setMode"), mode: PhoneModeSchema }),
  z.object({ kind: z.literal("setAlliesOnly"), value: z.boolean() }),
  z.object({ kind: z.literal("block"), target: ID }),
  z.object({ kind: z.literal("unblock"), target: ID }),
  // Undurchsichtige WebRTC-Nutzlast (SDP oder ICE), vom Server nur weitergereicht.
  z.object({
    kind: z.literal("signal"),
    to: ID,
    data: z.string().max(MAX_SIGNAL_BYTES),
  }),
]);

export const ClientPhoneMessageSchema = z.object({
  type: z.literal("phone"),
  payload: ClientPhonePayloadSchema,
});

export const ServerPhonePayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ringing"),
    callId: ID,
    from: ID,
    fromUsername: SafeString,
  }),
  // Der Anruf ist rausgegangen und klingelt beim Ziel.
  z.object({ kind: z.literal("dialing"), callId: ID }),
  // Einziger Ablehnungsgrund nach außen. Nie differenzieren.
  z.object({ kind: z.literal("busy") }),
  // Call verbunden bzw. Teilnehmerliste geändert. peers enthält NICHT den Empfänger.
  z.object({
    kind: z.literal("callState"),
    callId: ID,
    peers: ID.array(),
  }),
  z.object({ kind: z.literal("callEnded"), callId: ID }),
  z.object({
    kind: z.literal("missed"),
    from: ID,
    fromUsername: SafeString,
  }),
  z.object({
    kind: z.literal("signal"),
    from: ID,
    data: z.string().max(MAX_SIGNAL_BYTES),
  }),
]);

export const ServerPhoneMessageSchema = z.object({
  type: z.literal("phone"),
  payload: ServerPhonePayloadSchema,
});

export type ClientPhoneMessage = z.infer<typeof ClientPhoneMessageSchema>;
export type ServerPhoneMessage = z.infer<typeof ServerPhoneMessageSchema>;
export type ClientPhonePayload = z.infer<typeof ClientPhonePayloadSchema>;
export type ServerPhonePayload = z.infer<typeof ServerPhonePayloadSchema>;
```

Dann `ClientPhoneMessageSchema` als letzten Eintrag in `ClientMessageSchema` (Zeile ~911) und `ServerPhoneMessageSchema` als letzten Eintrag in `ServerMessageSchema` (Zeile ~817) ergänzen.

Außerdem in den Typ-Unions oben in der Datei ergänzen: `ClientPhoneMessage` zu `ClientMessage` (Zeile ~96) und `ServerPhoneMessage` zu `ServerMessage` (Zeile ~106).

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest tests/PhoneSchemas.test.ts --run
```

Expected: PASS (7 Tests).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/core/Schemas.ts tests/PhoneSchemas.test.ts
git commit -m "feat(phone): wire schemas for out-of-band call signaling"
```

---

### Task 2: Rate-Limit für Telefon-Nachrichten

Der Limiter drosselt aktuell **nur** `intent` (siehe `ClientMsgRateLimiter.ts:25`). Ohne eigenes Limit kann ein Client den Server mit Signaling fluten.

**Files:**

- Modify: `src/server/ClientMsgRateLimiter.ts`
- Test: `tests/server/PhoneRateLimiter.test.ts`

**Interfaces:**

- Consumes: nichts aus Task 1.
- Produces: `check(clientID, "phone", bytes)` liefert `"ok" | "limit" | "kick"`.

- [ ] **Step 1: Write the failing test**

Erstelle `tests/server/PhoneRateLimiter.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ClientMsgRateLimiter } from "../../src/server/ClientMsgRateLimiter";

const CLIENT_A = "clientA" as any;
const CLIENT_B = "clientB" as any;
const SMALL = 100;

describe("ClientMsgRateLimiter phone messages", () => {
  it("allows phone messages within limits", () => {
    const limiter = new ClientMsgRateLimiter();
    expect(limiter.check(CLIENT_A, "phone", SMALL)).toBe("ok");
  });

  it("allows a burst of signaling (ICE candidates arrive in clusters)", () => {
    const limiter = new ClientMsgRateLimiter();
    for (let i = 0; i < 30; i++) {
      expect(limiter.check(CLIENT_A, "phone", SMALL)).toBe("ok");
    }
  });

  it("limits sustained phone flooding", () => {
    const limiter = new ClientMsgRateLimiter();
    for (let i = 0; i < 30; i++) {
      limiter.check(CLIENT_A, "phone", SMALL);
    }
    expect(limiter.check(CLIENT_A, "phone", SMALL)).toBe("limit");
  });

  it("kicks oversized phone messages", () => {
    const limiter = new ClientMsgRateLimiter();
    expect(limiter.check(CLIENT_A, "phone", 30001)).toBe("kick");
  });

  it("phone limits are per client", () => {
    const limiter = new ClientMsgRateLimiter();
    for (let i = 0; i < 30; i++) {
      limiter.check(CLIENT_A, "phone", SMALL);
    }
    expect(limiter.check(CLIENT_B, "phone", SMALL)).toBe("ok");
  });

  it("phone traffic does not consume the intent budget", () => {
    const limiter = new ClientMsgRateLimiter();
    for (let i = 0; i < 30; i++) {
      limiter.check(CLIENT_A, "phone", SMALL);
    }
    expect(limiter.check(CLIENT_A, "intent", SMALL)).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest tests/server/PhoneRateLimiter.test.ts --run
```

Expected: FAIL — `"phone"` wird aktuell nicht gedrosselt, alles gibt `"ok"`.

- [ ] **Step 3: Add the phone bucket**

In `src/server/ClientMsgRateLimiter.ts`:

Konstanten oben ergänzen (nach Zeile 7):

```typescript
// Signaling kommt schubweise: ein SDP plus ein Schwall ICE-Kandidaten pro Peer.
// Großzügig genug für einen Konferenz-Aufbau mit fünf Peers, eng genug gegen Fluten.
const PHONE_PER_SECOND = 30;
const PHONE_PER_MINUTE = 300;
const MAX_PHONE_SIZE = 30000;
```

`ClientBucket` erweitern:

```typescript
interface ClientBucket {
  perSecond: RateLimiter;
  perMinute: RateLimiter;
  phonePerSecond: RateLimiter;
  phonePerMinute: RateLimiter;
  totalBytes: number;
}
```

In `check()` nach dem `intent`-Block (nach Zeile 40) einfügen:

```typescript
if (type === "phone") {
  if (bytes > MAX_PHONE_SIZE) {
    return "kick";
  }
  if (
    !bucket.phonePerSecond.tryRemoveTokens(1) ||
    !bucket.phonePerMinute.tryRemoveTokens(1)
  ) {
    return "limit";
  }
}
```

In `getOrCreate()` die zwei neuen Limiter ergänzen:

```typescript
      phonePerSecond: new RateLimiter({
        tokensPerInterval: PHONE_PER_SECOND,
        interval: "second",
      }),
      phonePerMinute: new RateLimiter({
        tokensPerInterval: PHONE_PER_MINUTE,
        interval: "minute",
      }),
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest tests/server/PhoneRateLimiter.test.ts tests/server/ClientMsgRateLimiter.test.ts --run
```

Expected: PASS. Der bestehende Test muss weiterhin grün sein — insbesondere `"does not rate-limit non-intent messages"`, der andere Typen prüft.

Falls der bestehende Test explizit `"phone"` als nicht-gedrosselt annimmt, ist er anzupassen: `"phone"` ist jetzt gedrosselt, das ist die Absicht.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/server/ClientMsgRateLimiter.ts tests/server/PhoneRateLimiter.test.ts tests/server/ClientMsgRateLimiter.test.ts
git commit -m "feat(phone): rate-limit signaling separately from intents"
```

---

### Task 3: PhoneExchange — Prüfkette und 1:1-Anrufe

Der sicherheitsrelevante Kern. Reine Logik, kein WebSocket: Nachrichten rein, Nachrichten raus.

**Files:**

- Create: `src/server/phone/PhoneTypes.ts`
- Create: `src/server/phone/PhoneExchange.ts`
- Test: `tests/server/PhoneExchange.test.ts`

**Interfaces:**

- Consumes: `ClientPhonePayload`, `ServerPhonePayload`, `PhoneMode`, `ClientID` aus Task 1.
- Produces:
  - `MAX_CALL_PARTICIPANTS = 6`, `RING_TIMEOUT_MS = 12000`
  - `interface PhoneParticipant { clientID: ClientID; username: string; isAllyOf(other: ClientID): boolean }`
  - `class PhoneExchange`:
    - `constructor(now: () => number)`
    - `addPlayer(p: PhoneParticipant): void`
    - `removePlayer(clientID: ClientID): PhoneOutbox[]`
    - `handle(from: ClientID, payload: ClientPhonePayload): PhoneOutbox[]`
    - `tick(): PhoneOutbox[]` — treibt Timeouts
  - `type PhoneOutbox = { to: ClientID; payload: ServerPhonePayload }`

- [ ] **Step 1: Write the failing test**

Erstelle `tests/server/PhoneExchange.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import {
  PhoneExchange,
  type PhoneOutbox,
  type PhoneParticipant,
} from "../../src/server/phone/PhoneExchange";

const A = "aaaa1111";
const B = "bbbb2222";
const C = "cccc3333";

let clock = 0;
const now = () => clock;

// Standard: niemand ist mit niemandem verbündet. Einzelne Tests überschreiben das.
let allies: Set<string> = new Set();
const allyKey = (x: string, y: string) => [x, y].sort().join("|");

function player(clientID: string, username: string): PhoneParticipant {
  return {
    clientID,
    username,
    isAllyOf: (other: string) => allies.has(allyKey(clientID, other)),
  };
}

function to(out: PhoneOutbox[], target: string) {
  return out.filter((o) => o.to === target).map((o) => o.payload);
}

function kinds(out: PhoneOutbox[], target: string) {
  return to(out, target).map((p) => p.kind);
}

describe("PhoneExchange", () => {
  let ex: PhoneExchange;

  beforeEach(() => {
    clock = 0;
    allies = new Set();
    ex = new PhoneExchange(now);
    ex.addPlayer(player(A, "Alice"));
    ex.addPlayer(player(B, "Bob"));
    ex.addPlayer(player(C, "Carol"));
  });

  it("rings the target and tells the caller it is dialing", () => {
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, B)).toContain("ringing");
    expect(kinds(out, A)).toContain("dialing");
  });

  it("connects both sides when the target answers", () => {
    ex.handle(A, { kind: "dial", target: B });
    const out = ex.handle(B, { kind: "answer" });
    const aState = to(out, A).find((p) => p.kind === "callState") as any;
    const bState = to(out, B).find((p) => p.kind === "callState") as any;
    expect(aState.peers).toEqual([B]);
    expect(bState.peers).toEqual([A]);
  });

  it("gives busy when the target has DND on", () => {
    ex.handle(B, { kind: "setMode", mode: "dnd" });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, A)).toEqual(["busy"]);
    expect(kinds(out, B)).toEqual([]);
  });

  it("still rings on silent mode (the caller cannot tell)", () => {
    ex.handle(B, { kind: "setMode", mode: "silent" });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, B)).toContain("ringing");
    expect(kinds(out, A)).toContain("dialing");
  });

  it("gives busy when the caller is blocked", () => {
    ex.handle(B, { kind: "block", target: A });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("gives busy when allies-only is on and the caller is no ally", () => {
    ex.handle(B, { kind: "setAlliesOnly", value: true });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("connects when allies-only is on and the caller is an ally", () => {
    allies.add(allyKey(A, B));
    ex.handle(B, { kind: "setAlliesOnly", value: true });
    const out = ex.handle(A, { kind: "dial", target: B });
    expect(kinds(out, B)).toContain("ringing");
  });

  it("gives busy when the target is already in a call", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.handle(C, { kind: "dial", target: B });
    expect(kinds(out, C)).toEqual(["busy"]);
  });

  it("gives busy when dialing an unknown player", () => {
    const out = ex.handle(A, { kind: "dial", target: "zzzz9999" });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("gives busy when dialing yourself", () => {
    const out = ex.handle(A, { kind: "dial", target: A });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("reports a missed call after the ring timeout", () => {
    ex.handle(A, { kind: "dial", target: B });
    clock = 11999;
    expect(ex.tick()).toEqual([]);
    clock = 12000;
    const out = ex.tick();
    const missed = to(out, B).find((p) => p.kind === "missed") as any;
    expect(missed.from).toBe(A);
    expect(missed.fromUsername).toBe("Alice");
    expect(kinds(out, A)).toContain("callEnded");
  });

  it("gives the caller busy when the target rejects", () => {
    ex.handle(A, { kind: "dial", target: B });
    const out = ex.handle(B, { kind: "hangup" });
    expect(kinds(out, A)).toContain("busy");
    const missed = to(out, B).find((p) => p.kind === "missed");
    expect(missed).toBeUndefined();
  });

  it("records a missed call when the caller gives up first", () => {
    ex.handle(A, { kind: "dial", target: B });
    const out = ex.handle(A, { kind: "hangup" });
    const missed = to(out, B).find((p) => p.kind === "missed") as any;
    expect(missed.from).toBe(A);
  });

  it("ends the call for the other side on hangup", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.handle(A, { kind: "hangup" });
    expect(kinds(out, B)).toContain("callEnded");
  });

  it("forwards signaling only to the named peer inside the call", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.handle(A, { kind: "signal", to: B, data: "sdp" });
    const sig = to(out, B).find((p) => p.kind === "signal") as any;
    expect(sig.from).toBe(A);
    expect(sig.data).toBe("sdp");
    expect(to(out, C)).toEqual([]);
  });

  it("drops signaling to someone outside the call", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.handle(A, { kind: "signal", to: C, data: "sdp" });
    expect(out).toEqual([]);
  });

  it("clears the call when a participant disconnects", () => {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
    const out = ex.removePlayer(A);
    expect(kinds(out, B)).toContain("callEnded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest tests/server/PhoneExchange.test.ts --run
```

Expected: FAIL — `src/server/phone/PhoneExchange.ts` existiert nicht.

- [ ] **Step 3: Write the implementation**

Erstelle `src/server/phone/PhoneTypes.ts`:

```typescript
import type { ClientID, PhoneMode } from "../../core/Schemas";

export type CallId = string;

export interface PhonePrefs {
  mode: PhoneMode;
  alliesOnly: boolean;
  blocked: Set<ClientID>;
}

export function defaultPrefs(): PhonePrefs {
  return { mode: "normal", alliesOnly: false, blocked: new Set() };
}

export interface Call {
  id: CallId;
  // Verbundene Teilnehmer. Beim ersten Klingeln nur der Anrufer.
  participants: Set<ClientID>;
  // Läuft ein Ruf, ist hier das Ziel und wann er ausläuft.
  ringing: Map<ClientID, { from: ClientID; expiresAt: number }>;
}
```

Erstelle `src/server/phone/PhoneExchange.ts`:

```typescript
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
    this.prefs.delete(clientID);
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

    // Blocks gelten gegenüber JEDEM Teilnehmer, sonst wäre der Block über den
    // Umweg Konferenz umgehbar.
    for (const peer of call.participants) {
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest tests/server/PhoneExchange.test.ts --run
```

Expected: PASS (18 Tests).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/server/phone tests/server/PhoneExchange.test.ts
git commit -m "feat(phone): server-side exchange with one-to-one call rules"
```

---

### Task 4: PhoneExchange — Konferenzen

Erweitert Task 3 um Dazuwählen, allseitige Blocks und das Sechser-Limit.

**Files:**

- Modify: `src/server/phone/PhoneExchange.ts` (falls Tests Lücken aufdecken)
- Test: `tests/server/PhoneExchangeConference.test.ts`

**Interfaces:**

- Consumes: `PhoneExchange`, `PhoneOutbox`, `PhoneParticipant`, `MAX_CALL_PARTICIPANTS` aus Task 3.
- Produces: keine neuen Symbole — bestätigt und härtet das Konferenz-Verhalten.

- [ ] **Step 1: Write the failing test**

Erstelle `tests/server/PhoneExchangeConference.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CALL_PARTICIPANTS,
  PhoneExchange,
  type PhoneOutbox,
  type PhoneParticipant,
} from "../../src/server/phone/PhoneExchange";

const NAMES = ["A", "B", "C", "D", "E", "F", "G"];
const ids = NAMES.map((n) => n.repeat(8));
const [A, B, C, D, E, F, G] = ids;

let clock = 0;
const now = () => clock;
let allies: Set<string> = new Set();
const allyKey = (x: string, y: string) => [x, y].sort().join("|");

function player(clientID: string, username: string): PhoneParticipant {
  return {
    clientID,
    username,
    isAllyOf: (other: string) => allies.has(allyKey(clientID, other)),
  };
}

function to(out: PhoneOutbox[], target: string) {
  return out.filter((o) => o.to === target).map((o) => o.payload);
}

function kinds(out: PhoneOutbox[], target: string) {
  return to(out, target).map((p) => p.kind);
}

describe("PhoneExchange conferences", () => {
  let ex: PhoneExchange;

  beforeEach(() => {
    clock = 0;
    allies = new Set();
    ex = new PhoneExchange(now);
    ids.forEach((id, i) => ex.addPlayer(player(id, NAMES[i])));
  });

  // Bringt A und B in ein verbundenes Gespräch.
  function connectAB() {
    ex.handle(A, { kind: "dial", target: B });
    ex.handle(B, { kind: "answer" });
  }

  it("lets a participant pull in a third player", () => {
    connectAB();
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, C)).toContain("ringing");
  });

  it("gives everyone the full peer list once the third answers", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    const out = ex.handle(C, { kind: "answer" });
    const peersOf = (who: string) =>
      (to(out, who).find((p) => p.kind === "callState") as any).peers.sort();
    expect(peersOf(A)).toEqual([B, C].sort());
    expect(peersOf(B)).toEqual([A, C].sort());
    expect(peersOf(C)).toEqual([A, B].sort());
  });

  it("lets a non-initiator pull someone in too (no host)", () => {
    connectAB();
    const out = ex.handle(B, { kind: "dial", target: C });
    expect(kinds(out, C)).toContain("ringing");
  });

  it("refuses to pull in someone who blocked another participant", () => {
    connectAB();
    ex.handle(C, { kind: "block", target: B });
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, A)).toEqual(["busy"]);
    expect(kinds(out, C)).toEqual([]);
  });

  it("refuses to pull in someone a participant has blocked", () => {
    connectAB();
    ex.handle(B, { kind: "block", target: C });
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, A)).toEqual(["busy"]);
  });

  it("applies allies-only only against the dialer, not the whole room", () => {
    allies.add(allyKey(A, C));
    connectAB();
    ex.handle(C, { kind: "setAlliesOnly", value: true });
    // A ist mit C verbündet, B nicht — A darf C trotzdem dazuholen.
    const out = ex.handle(A, { kind: "dial", target: C });
    expect(kinds(out, C)).toContain("ringing");
  });

  it("caps the call at MAX_CALL_PARTICIPANTS", () => {
    connectAB();
    for (const who of [C, D, E, F]) {
      ex.handle(A, { kind: "dial", target: who });
      ex.handle(who, { kind: "answer" });
    }
    // A,B,C,D,E,F = 6 -> voll.
    const out = ex.handle(A, { kind: "dial", target: G });
    expect(kinds(out, A)).toEqual(["busy"]);
    expect(MAX_CALL_PARTICIPANTS).toBe(6);
  });

  it("counts pending rings against the cap", () => {
    connectAB();
    for (const who of [C, D, E]) {
      ex.handle(A, { kind: "dial", target: who });
      ex.handle(who, { kind: "answer" });
    }
    // A,B,C,D,E = 5 verbunden. Ein Ruf an F macht 6 -> erlaubt, aber blockiert G.
    ex.handle(A, { kind: "dial", target: F });
    const out = ex.handle(B, { kind: "dial", target: G });
    expect(kinds(out, G)).toEqual([]);
    expect(kinds(out, B)).toEqual(["busy"]);
  });

  it("keeps the ring alive when the dialer hangs up mid-ring", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    const out = ex.handle(A, { kind: "hangup" });
    // B telefoniert weiter, bei C klingelt es unverändert.
    expect(kinds(out, C)).not.toContain("missed");
    const answered = ex.handle(C, { kind: "answer" });
    const bState = to(answered, B).find((p) => p.kind === "callState") as any;
    expect(bState.peers).toEqual([C]);
  });

  it("cancels a pending ring as missed when the call collapses", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    ex.handle(A, { kind: "hangup" });
    const out = ex.handle(B, { kind: "hangup" });
    const missed = to(out, C).find((p) => p.kind === "missed") as any;
    expect(missed.from).toBe(A);
  });

  it("keeps the call running when one of three drops out", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    ex.handle(C, { kind: "answer" });
    const out = ex.handle(C, { kind: "hangup" });
    const aState = to(out, A).find((p) => p.kind === "callState") as any;
    expect(aState.peers).toEqual([B]);
    expect(kinds(out, A)).not.toContain("callEnded");
  });

  it("ends the call for the last person standing", () => {
    connectAB();
    const out = ex.handle(B, { kind: "hangup" });
    expect(kinds(out, A)).toContain("callEnded");
  });

  it("routes signaling between any two peers in a conference", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    ex.handle(C, { kind: "answer" });
    const out = ex.handle(B, { kind: "signal", to: C, data: "ice" });
    const sig = to(out, C).find((p) => p.kind === "signal") as any;
    expect(sig.from).toBe(B);
    expect(to(out, A)).toEqual([]);
  });

  it("removes a disconnected participant but keeps the rest talking", () => {
    connectAB();
    ex.handle(A, { kind: "dial", target: C });
    ex.handle(C, { kind: "answer" });
    const out = ex.removePlayer(B);
    const aState = to(out, A).find((p) => p.kind === "callState") as any;
    expect(aState.peers).toEqual([C]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest tests/server/PhoneExchangeConference.test.ts --run
```

Expected: Einige Tests schlagen fehl. Die Implementierung aus Task 3 deckt den Grundfall ab; erwarte Lücken bei der Cap-Zählung mit ausstehenden Rufen und beim Weiterlaufen nach Auflegen des Rufenden.

- [ ] **Step 3: Fix the implementation until conferences behave**

Arbeite die Fehlschläge einzeln ab in `src/server/phone/PhoneExchange.ts`. Erwartete Korrekturstellen:

1. **Cap-Zählung** in `dial()`: `projected` muss `participants.size + ringing.size + 1` sein — ausstehende Rufe zählen mit, sonst kann ein Call über sechs wachsen.
2. **`leaveCall()`**: Rufe, die der Auflegende ausgelöst hat, dürfen **nicht** abgebrochen werden, solange noch jemand verbunden ist. Nur `collapseIfEmpty()` bricht sie ab.
3. **`broadcastState()` nach dem Verlassen**: Nach `participants.delete(who)` müssen die Verbliebenen eine aktualisierte `callState` bekommen, sofern der Call weiterlebt.

Ändere **keine** Prüfreihenfolge in `dial()`, ohne dass ein Test es verlangt — die Reihenfolge ist sicherheitsrelevant.

- [ ] **Step 4: Run both exchange test files**

```bash
npx vitest tests/server/PhoneExchange.test.ts tests/server/PhoneExchangeConference.test.ts --run
```

Expected: PASS. Task 3 muss grün bleiben.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/server/phone tests/server/PhoneExchangeConference.test.ts
git commit -m "feat(phone): mesh conferences with all-ways block enforcement"
```

---

### Task 5: GameServer-Anbindung

Verdrahtet die Vermittlungsstelle mit echten WebSockets.

**Files:**

- Modify: `src/server/GameServer.ts`
- Test: manuell (die bestehende Server-Testinfrastruktur deckt Socket-Verdrahtung nicht ab)

**Interfaces:**

- Consumes: `PhoneExchange`, `PhoneOutbox` (Task 3), `ClientPhoneMessage` (Task 1).
- Produces: `GameServer` leitet `"phone"`-Nachrichten weiter und meldet Disconnects an die Vermittlungsstelle.

- [ ] **Step 1: Add the exchange to GameServer**

In `src/server/GameServer.ts` bei den übrigen Imports ergänzen:

```typescript
import { PhoneExchange, type PhoneOutbox } from "./phone/PhoneExchange";
```

Als Feld neben `activeClients` (Zeile ~111):

```typescript
  private phoneExchange = new PhoneExchange(() => Date.now());
```

- [ ] **Step 2: Register players when they join**

In der Methode, die `this.activeClients.push(client)` ausführt (Zeile ~777), direkt danach einfügen:

```typescript
this.phoneExchange.addPlayer({
  clientID: client.clientID,
  username: client.username,
  // Bündnisse leben in der Client-Simulation, nicht auf dem Server. Der
  // Verbündeten-Filter greift daher serverseitig nur, wenn beide Seiten
  // im selben Team der Lobby-Konfiguration sitzen.
  isAllyOf: (other) => this.sameTeam(client.clientID, other),
});
```

- [ ] **Step 3: Add the team helper**

Als private Methode in `GameServer` ergänzen:

```typescript
  // Team-Zugehörigkeit aus der Lobby-Konfiguration. Für Spielmodi ohne Teams
  // ist niemand verbündet, dann wirkt der Verbündeten-Filter wie "niemand".
  private sameTeam(a: ClientID, b: ClientID): boolean {
    const teamOf = (id: ClientID) =>
      this.allClients.get(id)?.claims?.team ?? null;
    const teamA = teamOf(a);
    const teamB = teamOf(b);
    return teamA !== null && teamA === teamB;
  }
```

Falls `claims.team` nicht existiert, prüfe die tatsächliche Team-Quelle in `GameServer` (suche nach `team`) und passe den Helper an. Existiert serverseitig keine Team-Information, gib `false` zurück und dokumentiere das mit einem Kommentar — der Verbündeten-Filter wirkt dann als „niemand darf anrufen", was die sichere Richtung ist.

- [ ] **Step 4: Handle the phone message**

Im `switch (clientMsg.type)` (Zeile ~966) vor dem `default:`-Zweig einfügen:

```typescript
          case "phone": {
            const out = this.phoneExchange.handle(
              client.clientID,
              clientMsg.payload,
            );
            this.deliverPhone(out);
            break;
          }
```

- [ ] **Step 5: Add the delivery helper**

```typescript
  private deliverPhone(out: PhoneOutbox[]): void {
    for (const item of out) {
      const target = this.allClients.get(item.to);
      if (!target || target.ws.readyState !== WebSocket.OPEN) continue;
      try {
        target.ws.send(
          JSON.stringify({ type: "phone", payload: item.payload }),
        );
      } catch (e) {
        this.log.warn("failed to deliver phone message", {
          clientID: item.to,
          error: String(e),
        });
      }
    }
  }
```

Prüfe den bestehenden Sende-Stil in `GameServer` (suche nach `ws.send(`) und folge ihm, falls dort ein Helper existiert.

- [ ] **Step 6: Drive ring timeouts from the game loop**

Suche die bestehende Tick-/Intervall-Methode des `GameServer` (dort, wo Turns erzeugt werden) und ergänze am Ende:

```typescript
this.deliverPhone(this.phoneExchange.tick());
```

- [ ] **Step 7: Clear players on disconnect**

In der Methode, die einen Client als getrennt markiert bzw. entfernt (suche nach `markClientDisconnected` und dem Kick-Pfad), ergänzen:

```typescript
this.deliverPhone(this.phoneExchange.removePlayer(clientID));
```

- [ ] **Step 8: Typecheck and run the server test suite**

```bash
npx tsc --noEmit
npx vitest tests/server --run
```

Expected: Keine Typfehler, bestehende Server-Tests bleiben grün.

- [ ] **Step 9: Commit**

```bash
npm run format
git add src/server/GameServer.ts
git commit -m "feat(phone): route call signaling through the game server"
```

---

### Task 6: Client-Zustandsautomat

Reine Logik. Kein WebRTC, kein DOM, kein Netzwerk.

**Files:**

- Create: `src/client/phone/CallStateMachine.ts`
- Test: `tests/PhoneCallStateMachine.test.ts`

**Interfaces:**

- Consumes: `ServerPhonePayload`, `ClientID` (Task 1).
- Produces:
  - `type PhoneUiState = "idle" | "dialing" | "ringing" | "in-call" | "busy"`
  - `interface MissedCall { from: ClientID; username: string }`
  - `class CallStateMachine`:
    - `get state(): PhoneUiState`
    - `get peers(): ClientID[]`
    - `get missed(): MissedCall[]`
    - `get incoming(): { from: ClientID; username: string } | null`
    - `receive(payload: ServerPhonePayload): void`
    - `clearMissed(): void`
    - `onChange(listener: () => void): () => void`

- [ ] **Step 1: Write the failing test**

Erstelle `tests/PhoneCallStateMachine.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallStateMachine } from "../src/client/phone/CallStateMachine";

const A = "aaaa1111";
const B = "bbbb2222";

describe("CallStateMachine", () => {
  let m: CallStateMachine;

  beforeEach(() => {
    vi.useFakeTimers();
    m = new CallStateMachine();
  });

  it("starts idle", () => {
    expect(m.state).toBe("idle");
    expect(m.peers).toEqual([]);
  });

  it("goes to dialing", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    expect(m.state).toBe("dialing");
  });

  it("goes to ringing and exposes the caller", () => {
    m.receive({
      kind: "ringing",
      callId: "c1",
      from: A,
      fromUsername: "Alice",
    });
    expect(m.state).toBe("ringing");
    expect(m.incoming).toEqual({ from: A, username: "Alice" });
  });

  it("enters the call and lists peers", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "callState", callId: "c1", peers: [B] });
    expect(m.state).toBe("in-call");
    expect(m.peers).toEqual([B]);
  });

  it("updates the peer list as a conference grows", () => {
    m.receive({ kind: "callState", callId: "c1", peers: [A] });
    m.receive({ kind: "callState", callId: "c1", peers: [A, B] });
    expect(m.peers).toEqual([A, B]);
  });

  it("returns to idle when the call ends", () => {
    m.receive({ kind: "callState", callId: "c1", peers: [B] });
    m.receive({ kind: "callEnded", callId: "c1" });
    expect(m.state).toBe("idle");
    expect(m.peers).toEqual([]);
  });

  it("shows busy and falls back to idle on its own", () => {
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "busy" });
    expect(m.state).toBe("busy");
    vi.advanceTimersByTime(2999);
    expect(m.state).toBe("busy");
    vi.advanceTimersByTime(1);
    expect(m.state).toBe("idle");
  });

  it("collects missed calls", () => {
    m.receive({ kind: "missed", from: A, fromUsername: "Alice" });
    m.receive({ kind: "missed", from: B, fromUsername: "Bob" });
    expect(m.missed).toEqual([
      { from: A, username: "Alice" },
      { from: B, username: "Bob" },
    ]);
  });

  it("clears missed calls on demand", () => {
    m.receive({ kind: "missed", from: A, fromUsername: "Alice" });
    m.clearMissed();
    expect(m.missed).toEqual([]);
  });

  it("drops the incoming caller once answered", () => {
    m.receive({
      kind: "ringing",
      callId: "c1",
      from: A,
      fromUsername: "Alice",
    });
    m.receive({ kind: "callState", callId: "c1", peers: [A] });
    expect(m.incoming).toBeNull();
  });

  it("notifies listeners on every change", () => {
    const seen: string[] = [];
    m.onChange(() => seen.push(m.state));
    m.receive({ kind: "dialing", callId: "c1" });
    m.receive({ kind: "callState", callId: "c1", peers: [B] });
    expect(seen).toEqual(["dialing", "in-call"]);
  });

  it("stops notifying after unsubscribe", () => {
    let count = 0;
    const off = m.onChange(() => count++);
    m.receive({ kind: "dialing", callId: "c1" });
    off();
    m.receive({ kind: "callEnded", callId: "c1" });
    expect(count).toBe(1);
  });

  it("ignores signal payloads (transport handles those)", () => {
    m.receive({ kind: "signal", from: A, data: "sdp" });
    expect(m.state).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest tests/PhoneCallStateMachine.test.ts --run
```

Expected: FAIL — Datei existiert nicht.

- [ ] **Step 3: Write the implementation**

Erstelle `src/client/phone/CallStateMachine.ts`:

```typescript
import type { ClientID, ServerPhonePayload } from "../../core/Schemas";

export type PhoneUiState = "idle" | "dialing" | "ringing" | "in-call" | "busy";

export interface MissedCall {
  from: ClientID;
  username: string;
}

// Wie lange das Besetztzeichen stehen bleibt, bevor der Apparat auflegt.
export const BUSY_TONE_MS = 3000;

export class CallStateMachine {
  private _state: PhoneUiState = "idle";
  private _peers: ClientID[] = [];
  private _missed: MissedCall[] = [];
  private _incoming: { from: ClientID; username: string } | null = null;
  private _callId: string | null = null;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  get state(): PhoneUiState {
    return this._state;
  }

  get peers(): ClientID[] {
    return this._peers;
  }

  get missed(): MissedCall[] {
    return this._missed;
  }

  get incoming(): { from: ClientID; username: string } | null {
    return this._incoming;
  }

  get callId(): string | null {
    return this._callId;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clearMissed(): void {
    if (this._missed.length === 0) return;
    this._missed = [];
    this.emit();
  }

  receive(payload: ServerPhonePayload): void {
    switch (payload.kind) {
      case "dialing":
        this.cancelBusy();
        this._callId = payload.callId;
        this.set("dialing");
        break;
      case "ringing":
        this.cancelBusy();
        this._callId = payload.callId;
        this._incoming = { from: payload.from, username: payload.fromUsername };
        this.set("ringing");
        break;
      case "callState":
        this.cancelBusy();
        this._callId = payload.callId;
        this._peers = payload.peers;
        this._incoming = null;
        this.set("in-call");
        break;
      case "callEnded":
        this.reset();
        this.set("idle");
        break;
      case "busy":
        this.reset();
        this._state = "busy";
        this.busyTimer = setTimeout(() => {
          this.busyTimer = null;
          this.set("idle");
        }, BUSY_TONE_MS);
        this.emit();
        break;
      case "missed":
        this._missed = [
          ...this._missed,
          { from: payload.from, username: payload.fromUsername },
        ];
        this.emit();
        break;
      case "signal":
        // Gehört dem Transport, nicht dem Automaten.
        break;
    }
  }

  private reset(): void {
    this.cancelBusy();
    this._peers = [];
    this._incoming = null;
    this._callId = null;
  }

  private cancelBusy(): void {
    if (this.busyTimer !== null) {
      clearTimeout(this.busyTimer);
      this.busyTimer = null;
    }
  }

  private set(next: PhoneUiState): void {
    this._state = next;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest tests/PhoneCallStateMachine.test.ts --run
```

Expected: PASS (13 Tests).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/client/phone/CallStateMachine.ts tests/PhoneCallStateMachine.test.ts
git commit -m "feat(phone): client call state machine"
```

---

### Task 7: Telefon-Klangkette

Die Web-Audio-Kette, die aus einem WebRTC-Stream eine Telefonleitung macht.

**Files:**

- Create: `src/client/phone/PhoneAudio.ts`
- Test: manuell (Web Audio lässt sich ohne echten Audiokontext nicht sinnvoll prüfen)

**Interfaces:**

- Consumes: nichts.
- Produces: `class PhoneAudio` mit `attach(stream: MediaStream): void`, `detach(): void`, `setVolume(v: number): void`.

- [ ] **Step 1: Write the implementation**

Erstelle `src/client/phone/PhoneAudio.ts`:

```typescript
// Klassisches Fernsprechband: unter 300 Hz und über 3,4 kHz ist nichts.
const HIGHPASS_HZ = 300;
const LOWPASS_HZ = 3400;
const FILTER_Q = 0.9;

// Erzeugt eine weiche Sättigungskurve. Sanftes Clipping lässt die Stimme nach
// Leitung klingen statt nach sauberem EQ.
function saturationCurve(amount: number): Float32Array {
  const samples = 1024;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(x * amount);
  }
  return curve;
}

// Eine Leitung pro Gesprächspartner: Bandpass, Kompression, Sättigung.
export class PhoneAudio {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  // Ein stummes <audio>-Element hält den Stream in Chrome am Leben; ohne das
  // liefert der WebRTC-Stream in manchen Versionen keine Samples an Web Audio.
  private keepAlive: HTMLAudioElement | null = null;
  private volume = 1;

  attach(stream: MediaStream): void {
    this.detach();
    try {
      this.keepAlive = new Audio();
      this.keepAlive.srcObject = stream;
      this.keepAlive.muted = true;
      void this.keepAlive.play().catch(() => {});

      const ctx = new AudioContext();
      this.ctx = ctx;
      this.source = ctx.createMediaStreamSource(stream);

      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = HIGHPASS_HZ;
      highpass.Q.value = FILTER_Q;

      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = LOWPASS_HZ;
      lowpass.Q.value = FILTER_Q;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.15;

      const shaper = ctx.createWaveShaper();
      shaper.curve = saturationCurve(1.6);
      shaper.oversample = "2x";

      this.gain = ctx.createGain();
      this.gain.gain.value = this.volume;

      this.source
        .connect(highpass)
        .connect(lowpass)
        .connect(compressor)
        .connect(shaper)
        .connect(this.gain)
        .connect(ctx.destination);
    } catch (err) {
      console.error("PhoneAudio: failed to build the line", err);
      this.detach();
    }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  detach(): void {
    try {
      this.source?.disconnect();
      this.gain?.disconnect();
      void this.ctx?.close();
    } catch {
      // Aufräumen darf nie den Anruf mitreißen.
    }
    if (this.keepAlive) {
      this.keepAlive.srcObject = null;
      this.keepAlive = null;
    }
    this.source = null;
    this.gain = null;
    this.ctx = null;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: Keine Fehler.

- [ ] **Step 3: Commit**

```bash
npm run format
git add src/client/phone/PhoneAudio.ts
git commit -m "feat(phone): telephone-band audio chain for incoming voice"
```

---

### Task 8: WebRTC-Transport

Verwaltet die Peer-Verbindungen, das Mikrofon und das Mesh.

**Files:**

- Create: `src/client/phone/PhoneTransport.ts`
- Test: manuell

**Interfaces:**

- Consumes: `PhoneAudio` (Task 7), `ClientID` (Task 1).
- Produces:
  - `class PhoneTransport`:
    - `constructor(myId: ClientID, send: (to: ClientID, data: string) => void)`
    - `syncPeers(peers: ClientID[]): Promise<void>`
    - `handleSignal(from: ClientID, data: string): Promise<void>`
    - `setMuted(muted: boolean): void`
    - `get micDenied(): boolean`
    - `setVolume(v: number): void`
    - `teardown(): void`

- [ ] **Step 1: Write the implementation**

Erstelle `src/client/phone/PhoneTransport.ts`:

```typescript
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

  constructor(
    private readonly myId: ClientID,
    private readonly send: (to: ClientID, data: string) => void,
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
    await this.ensureMic();
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
    await this.ensureMic();
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
  private async ensureMic(): Promise<void> {
    if (this.localStream || this._micDenied) return;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.setMuted(this.muted);
    } catch {
      this._micDenied = true;
    }
  }

  private stopMic(): void {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: Keine Fehler.

- [ ] **Step 3: Commit**

```bash
npm run format
git add src/client/phone/PhoneTransport.ts
git commit -m "feat(phone): webrtc mesh transport with mic handling"
```

---

### Task 9: Einstellungen und Telefon-Geräusche

**Files:**

- Modify: `src/core/game/UserSettings.ts`
- Create: `src/client/phone/PhoneSounds.ts`
- Modify: `resources/lang/en.json`
- Test: `tests/PhoneSettings.test.ts`

**Interfaces:**

- Consumes: `PhoneMode` (Task 1).
- Produces:
  - `UserSettings.phoneMode(): PhoneMode`, `setPhoneMode(m: PhoneMode)`, `phoneAlliesOnly(): boolean`, `setPhoneAlliesOnly(v: boolean)`, `phoneVolume(): number`, `setPhoneVolume(v: number)`
  - `class PhoneSounds` mit `startRinging()`, `startDialTone()`, `startBusyTone()`, `stopAll()`, `playDialClick()`, `playPickUp()`, `playHangUp()`, `setVolume(v)`

- [ ] **Step 1: Write the failing test**

Erstelle `tests/PhoneSettings.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { UserSettings } from "../src/core/game/UserSettings";

describe("phone user settings", () => {
  let s: UserSettings;

  beforeEach(() => {
    localStorage.clear();
    (UserSettings as any).cache = new Map();
    s = new UserSettings();
  });

  it("defaults to normal mode (phone is on by default)", () => {
    expect(s.phoneMode()).toBe("normal");
  });

  it("round-trips the mode", () => {
    s.setPhoneMode("dnd");
    expect(s.phoneMode()).toBe("dnd");
  });

  it("falls back to normal on a corrupted value", () => {
    localStorage.setItem("settings.phoneMode", "nonsense");
    (UserSettings as any).cache = new Map();
    expect(new UserSettings().phoneMode()).toBe("normal");
  });

  it("defaults allies-only to off", () => {
    expect(s.phoneAlliesOnly()).toBe(false);
  });

  it("round-trips allies-only", () => {
    s.setPhoneAlliesOnly(true);
    expect(s.phoneAlliesOnly()).toBe(true);
  });

  it("defaults the phone volume to full", () => {
    expect(s.phoneVolume()).toBe(1);
  });

  it("round-trips the phone volume", () => {
    s.setPhoneVolume(0.4);
    expect(s.phoneVolume()).toBeCloseTo(0.4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest tests/PhoneSettings.test.ts --run
```

Expected: FAIL — die Getter existieren nicht.

- [ ] **Step 3: Add the settings**

In `src/core/game/UserSettings.ts` den Import ergänzen:

```typescript
import type { PhoneMode } from "../Schemas";
```

Und die Methoden bei den übrigen Gettern einfügen:

```typescript
  phoneMode(): PhoneMode {
    const raw = this.getString("settings.phoneMode", "normal");
    if (raw === "normal" || raw === "silent" || raw === "dnd") return raw;
    return "normal";
  }

  setPhoneMode(mode: PhoneMode): void {
    this.setString("settings.phoneMode", mode);
  }

  phoneAlliesOnly(): boolean {
    return this.getBool("settings.phoneAlliesOnly", false);
  }

  setPhoneAlliesOnly(value: boolean): void {
    this.setBool("settings.phoneAlliesOnly", value);
  }

  phoneVolume(): number {
    return this.getFloat("settings.phoneVolume", 1);
  }

  setPhoneVolume(value: number): void {
    this.setFloat("settings.phoneVolume", value);
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest tests/PhoneSettings.test.ts --run
```

Expected: PASS (7 Tests).

- [ ] **Step 5: Add the phone sounds**

Der bestehende `SoundManager` kann keine Loops (`SoundManager.ts:138` erzeugt Howls ohne `loop`), Klingeln und Freizeichen brauchen aber genau das. Deshalb eine eigene kleine Einheit.

Erstelle `src/client/phone/PhoneSounds.ts`:

```typescript
import { Howl } from "howler";
import { assetUrl } from "../../core/AssetUrls";

type LoopName = "ring" | "dial-tone" | "busy-tone";
type OneShotName = "dial-click" | "pick-up" | "hang-up";

const LOOP_URLS: Record<LoopName, string> = {
  ring: assetUrl("sounds/phone/ring.mp3"),
  "dial-tone": assetUrl("sounds/phone/dial-tone.mp3"),
  "busy-tone": assetUrl("sounds/phone/busy-tone.mp3"),
};

const ONE_SHOT_URLS: Record<OneShotName, string> = {
  "dial-click": assetUrl("sounds/phone/dial-click.mp3"),
  "pick-up": assetUrl("sounds/phone/pick-up.mp3"),
  "hang-up": assetUrl("sounds/phone/hang-up.mp3"),
};

// Wie im SoundManager: Slider sind linear, Lautstärke ist es nicht.
function perceptualGain(position: number): number {
  const clamped = Math.max(0, Math.min(1, position));
  return clamped * clamped;
}

export class PhoneSounds {
  private loops = new Map<LoopName, Howl>();
  private oneShots = new Map<OneShotName, Howl>();
  private active: LoopName | null = null;
  private volume = 1;

  constructor(volume: number) {
    this.volume = perceptualGain(volume);
  }

  setVolume(position: number): void {
    this.volume = perceptualGain(position);
    for (const howl of this.loops.values()) howl.volume(this.volume);
    for (const howl of this.oneShots.values()) howl.volume(this.volume);
  }

  startRinging(): void {
    this.startLoop("ring");
  }

  startDialTone(): void {
    this.startLoop("dial-tone");
  }

  startBusyTone(): void {
    this.startLoop("busy-tone");
  }

  stopAll(): void {
    if (!this.active) return;
    this.safely("stop loop", () => this.loops.get(this.active!)?.stop());
    this.active = null;
  }

  playDialClick(): void {
    this.playOneShot("dial-click");
  }

  playPickUp(): void {
    this.playOneShot("pick-up");
  }

  playHangUp(): void {
    this.playOneShot("hang-up");
  }

  dispose(): void {
    this.stopAll();
    for (const howl of this.loops.values())
      this.safely("unload", () => howl.unload());
    for (const howl of this.oneShots.values())
      this.safely("unload", () => howl.unload());
    this.loops.clear();
    this.oneShots.clear();
  }

  private startLoop(name: LoopName): void {
    if (this.active === name) return;
    this.stopAll();
    this.safely(`play ${name}`, () => {
      let howl = this.loops.get(name);
      if (!howl) {
        howl = new Howl({
          src: [LOOP_URLS[name]],
          loop: true,
          volume: this.volume,
        });
        this.loops.set(name, howl);
      }
      howl.volume(this.volume);
      howl.play();
      this.active = name;
    });
  }

  private playOneShot(name: OneShotName): void {
    this.safely(`play ${name}`, () => {
      let howl = this.oneShots.get(name);
      if (!howl) {
        howl = new Howl({ src: [ONE_SHOT_URLS[name]], volume: this.volume });
        this.oneShots.set(name, howl);
      }
      howl.volume(this.volume);
      howl.play();
    });
  }

  private safely(action: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`PhoneSounds: failed to ${action}`, err);
    }
  }
}
```

- [ ] **Step 6: Add the sound assets**

Lege die sechs Dateien unter `resources/sounds/phone/` ab: `ring.mp3`, `dial-tone.mp3`, `busy-tone.mp3`, `dial-click.mp3`, `pick-up.mp3`, `hang-up.mp3`.

`ring`, `dial-tone` und `busy-tone` müssen **nahtlos loopen** (Schnitt im Nulldurchgang, exakt eine Periode des Klingel- bzw. Tonzyklus).

Prüfe mit `ls resources/sounds/effects/`, wie bestehende Assets abgelegt sind, und folge Format und Größenordnung. Sind noch keine Audiodateien beschaffbar, lege Stille-Platzhalter gleicher Länge an und vermerke im Commit, dass die Assets noch ersetzt werden — der Code lädt sie über `assetUrl()` unverändert.

- [ ] **Step 7: Add translations**

In `resources/lang/en.json` ergänzen (alphabetisch einsortieren — es gibt einen Test `EnJsonSorted.test.ts`, der die Sortierung prüft):

```json
"phone": {
  "allies_only": "Allies only",
  "block": "Block",
  "busy": "Busy",
  "call": "Call",
  "calling": "Calling…",
  "dnd": "Do not disturb",
  "hang_up": "Hang up",
  "in_call": "In call",
  "incoming_call": "Incoming call",
  "mic_blocked": "Microphone blocked — you can listen but not speak",
  "missed_calls": "Missed calls",
  "mute": "Mute",
  "no_connection": "No connection",
  "normal": "Normal",
  "silent": "Silent",
  "title": "Telephone",
  "unblock": "Unblock",
  "unmute": "Unmute",
  "volume": "Ring volume"
}
```

- [ ] **Step 8: Run the settings and json tests**

```bash
npx vitest tests/PhoneSettings.test.ts tests/EnJsonSorted.test.ts --run
```

Expected: PASS. Schlägt `EnJsonSorted` fehl, sortiere die Schlüssel wie vom Test verlangt.

- [ ] **Step 9: Commit**

```bash
npm run format
git add src/core/game/UserSettings.ts src/client/phone/PhoneSounds.ts resources/lang/en.json resources/sounds/phone
git commit -m "feat(phone): settings, looping phone tones, and translations"
```

---

### Task 10: PhoneController

Verdrahtet Automat, Transport, Sounds und Netzwerk. Die einzige Stelle, die alle vier kennt.

**Files:**

- Create: `src/client/phone/PhoneController.ts`
- Modify: `src/client/Transport.ts`
- Test: manuell

**Interfaces:**

- Consumes: `CallStateMachine` (Task 6), `PhoneTransport` (Task 8), `PhoneSounds` (Task 9), `UserSettings` (Task 9), `ServerPhonePayload`/`ClientPhonePayload` (Task 1).
- Produces:
  - `Transport.sendPhone(payload: ClientPhonePayload): void`
  - `class PhoneController`:
    - `constructor(myId, transport, userSettings)`
    - `readonly machine: CallStateMachine`
    - `receive(payload: ServerPhonePayload): void`
    - `dial(target)`, `answer()`, `hangup()`, `setMode(m)`, `setAlliesOnly(v)`, `block(t)`, `unblock(t)`, `toggleMute()`, `setVolume(v)`
    - `get muted(): boolean`, `get micDenied(): boolean`, `get mode(): PhoneMode`, `get alliesOnly(): boolean`
    - `dispose(): void`

- [ ] **Step 1: Add the send path**

In `src/client/Transport.ts` bei den anderen `sendMsg`-Methoden (ab Zeile ~421) ergänzen:

```typescript
  sendPhone(payload: ClientPhonePayload) {
    this.sendMsg({
      type: "phone",
      payload,
    });
  }
```

Und `ClientPhonePayload` zum Import aus `../core/Schemas` hinzufügen.

- [ ] **Step 2: Write the controller**

Erstelle `src/client/phone/PhoneController.ts`:

```typescript
import type {
  ClientID,
  ClientPhonePayload,
  PhoneMode,
  ServerPhonePayload,
} from "../../core/Schemas";
import type { UserSettings } from "../../core/game/UserSettings";
import type { Transport } from "../Transport";
import { CallStateMachine } from "./CallStateMachine";
import { PhoneSounds } from "./PhoneSounds";
import { PhoneTransport } from "./PhoneTransport";

export class PhoneController {
  readonly machine = new CallStateMachine();
  private rtc: PhoneTransport;
  private sounds: PhoneSounds;
  private _muted = false;
  private unsubscribe: () => void;

  constructor(
    myId: ClientID,
    private readonly transport: Transport,
    private readonly userSettings: UserSettings,
  ) {
    this.sounds = new PhoneSounds(userSettings.phoneVolume());
    this.rtc = new PhoneTransport(myId, (to, data) =>
      this.send({ kind: "signal", to, data }),
    );
    this.unsubscribe = this.machine.onChange(() => this.onStateChange());

    // Die serverseitige Prüfung braucht die gespeicherten Präferenzen.
    this.send({ kind: "setMode", mode: userSettings.phoneMode() });
    this.send({
      kind: "setAlliesOnly",
      value: userSettings.phoneAlliesOnly(),
    });
  }

  get muted(): boolean {
    return this._muted;
  }

  get micDenied(): boolean {
    return this.rtc.micDenied;
  }

  // Die UI liest den Modus hierüber, statt in die Einstellungen zu greifen.
  get mode(): PhoneMode {
    return this.userSettings.phoneMode();
  }

  get alliesOnly(): boolean {
    return this.userSettings.phoneAlliesOnly();
  }

  get volume(): number {
    return this.userSettings.phoneVolume();
  }

  receive(payload: ServerPhonePayload): void {
    if (payload.kind === "signal") {
      void this.rtc.handleSignal(payload.from, payload.data);
      return;
    }
    this.machine.receive(payload);
    if (payload.kind === "callState") {
      void this.rtc.syncPeers(payload.peers);
    } else if (payload.kind === "callEnded") {
      void this.rtc.syncPeers([]);
    }
  }

  dial(target: ClientID): void {
    this.sounds.playDialClick();
    this.send({ kind: "dial", target });
  }

  answer(): void {
    this.sounds.playPickUp();
    this.send({ kind: "answer" });
  }

  hangup(): void {
    this.sounds.playHangUp();
    this.send({ kind: "hangup" });
  }

  setMode(mode: PhoneMode): void {
    this.userSettings.setPhoneMode(mode);
    this.send({ kind: "setMode", mode });
  }

  setAlliesOnly(value: boolean): void {
    this.userSettings.setPhoneAlliesOnly(value);
    this.send({ kind: "setAlliesOnly", value });
  }

  block(target: ClientID): void {
    this.send({ kind: "block", target });
  }

  unblock(target: ClientID): void {
    this.send({ kind: "unblock", target });
  }

  toggleMute(): void {
    this._muted = !this._muted;
    this.rtc.setMuted(this._muted);
  }

  setVolume(v: number): void {
    this.userSettings.setPhoneVolume(v);
    this.sounds.setVolume(v);
    this.rtc.setVolume(v);
  }

  dispose(): void {
    this.unsubscribe();
    this.sounds.dispose();
    this.rtc.teardown();
  }

  // Der Apparat klingt nach dem, was er gerade tut.
  private onStateChange(): void {
    switch (this.machine.state) {
      case "dialing":
        this.sounds.startDialTone();
        break;
      case "ringing":
        // Im Lautlos-Modus bleibt es still, der Anruf ist aber sichtbar.
        if (this.userSettings.phoneMode() === "silent") this.sounds.stopAll();
        else this.sounds.startRinging();
        break;
      case "busy":
        this.sounds.startBusyTone();
        break;
      case "in-call":
      case "idle":
        this.sounds.stopAll();
        break;
    }
  }

  private send(payload: ClientPhonePayload): void {
    this.transport.sendPhone(payload);
  }
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: Keine Fehler.

- [ ] **Step 4: Commit**

```bash
npm run format
git add src/client/phone/PhoneController.ts src/client/Transport.ts
git commit -m "feat(phone): controller wiring state, transport, and tones"
```

---

### Task 11: Das Telefon-UI

Der Apparat. Overlay, kein Modal — das Spiel bleibt bedienbar.

**Files:**

- Create: `src/client/hud/layers/PhoneWidget.ts`
- Modify: `index.html`
- Modify: `src/client/hud/GameRenderer.ts`
- Test: manuell

**Interfaces:**

- Consumes: `PhoneController` (Task 10), `GameView`/`PlayerView` (bestehend).
- Produces: Custom Element `<phone-widget>` mit den Feldern `controller`, `game`.

- [ ] **Step 1: Write the component**

Erstelle `src/client/hud/layers/PhoneWidget.ts`. Folge dem Muster von `EmojiTable.ts`: `LitElement`, `@customElement`, `@state`, und **`createRenderRoot() { return this; }`**, damit Tailwind-Klassen greifen (prüfe in `EmojiTable.ts`, ob dort ebenso verfahren wird, und folge dem).

```typescript
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "../../Utils";
import type { PhoneController } from "../../phone/PhoneController";
import type { GameView, PlayerView } from "../../view";

@customElement("phone-widget")
export class PhoneWidget extends LitElement {
  public controller: PhoneController | null = null;
  public game: GameView | null = null;

  @state() private expanded = false;
  @state() private tick = 0;

  private unsubscribe: (() => void) | null = null;
  private blocked = new Set<string>();

  createRenderRoot() {
    return this;
  }

  init(controller: PhoneController, game: GameView) {
    this.controller = controller;
    this.game = game;
    this.unsubscribe?.();
    this.unsubscribe = controller.machine.onChange(() => {
      // Ein eingehender Anruf klappt den Apparat von selbst auf.
      if (controller.machine.state === "ringing") this.expanded = true;
      this.tick++;
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // Nur echte Mitspieler stehen im Verzeichnis, keine Bots und keine Nations.
  private callables(): PlayerView[] {
    const me = this.game?.myPlayer();
    return (this.game?.playerViews() ?? []).filter(
      (p) => p.isPlayer() && p.clientID() !== null && p !== me,
    );
  }

  render() {
    if (!this.controller || !this.game) return html``;
    return this.expanded ? this.renderApparatus() : this.renderMini();
  }

  private renderMini() {
    const missed = this.controller!.machine.missed.length;
    const state = this.controller!.machine.state;
    const shaking = state === "ringing";
    return html`
      <div
        class="fixed bottom-24 right-4 z-50 cursor-pointer select-none"
        @click=${() => (this.expanded = true)}
        title=${translateText("phone.title")}
      >
        <div
          class="relative w-16 h-16 rounded-lg bg-red-700 border-2 border-red-900 shadow-lg flex items-center justify-center ${shaking
            ? "animate-bounce"
            : ""}"
        >
          <span class="text-3xl">☎️</span>
          ${missed > 0
            ? html`<span
                class="absolute -top-1 -right-1 bg-yellow-400 text-black text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center"
                >${missed}</span
              >`
            : ""}
        </div>
      </div>
    `;
  }

  private renderApparatus() {
    const m = this.controller!.machine;
    return html`
      <div
        class="fixed bottom-24 right-4 z-50 w-[min(28rem,90vw)] max-h-[60vh] overflow-y-auto rounded-xl bg-red-800 border-4 border-red-950 shadow-2xl text-white p-3"
      >
        <div class="flex items-center justify-between mb-2">
          <span class="font-bold">${translateText("phone.title")}</span>
          <button
            class="px-2 py-1 rounded bg-red-950 hover:bg-black"
            @click=${() => (this.expanded = false)}
          >
            ✕
          </button>
        </div>

        ${this.renderStatus()} ${this.renderModeSwitch()}
        ${m.state === "in-call" ? this.renderInCall() : this.renderDirectory()}
        ${this.renderMissed()} ${this.renderVolume()}
      </div>
    `;
  }

  private renderStatus() {
    const m = this.controller!.machine;
    const label = {
      idle: "",
      dialing: translateText("phone.calling"),
      ringing: translateText("phone.incoming_call"),
      "in-call": translateText("phone.in_call"),
      busy: translateText("phone.busy"),
    }[m.state];
    if (!label) return html``;
    return html`
      <div class="mb-2 p-2 rounded bg-red-950 flex items-center gap-2">
        <span class="font-semibold">${label}</span>
        ${m.state === "ringing" && m.incoming
          ? html`<span>${m.incoming.username}</span>
              <button
                class="ml-auto px-3 py-1 rounded bg-green-600 hover:bg-green-500"
                @click=${() => this.controller!.answer()}
              >
                ${translateText("phone.call")}
              </button>`
          : ""}
        ${m.state === "dialing" || m.state === "in-call"
          ? html`<button
              class="ml-auto px-3 py-1 rounded bg-black hover:bg-gray-800"
              @click=${() => this.controller!.hangup()}
            >
              ${translateText("phone.hang_up")}
            </button>`
          : ""}
      </div>
      ${this.controller!.micDenied
        ? html`<div class="mb-2 text-xs text-yellow-300">
            ${translateText("phone.mic_blocked")}
          </div>`
        : ""}
    `;
  }

  private renderModeSwitch() {
    const current = this.controller!.mode;
    const modes: Array<["normal" | "silent" | "dnd", string]> = [
      ["normal", translateText("phone.normal")],
      ["silent", translateText("phone.silent")],
      ["dnd", translateText("phone.dnd")],
    ];
    return html`
      <div class="flex gap-1 mb-2">
        ${modes.map(
          ([value, label]) => html`
            <button
              class="flex-1 px-2 py-1 rounded text-xs ${current === value
                ? "bg-yellow-400 text-black font-bold"
                : "bg-red-950 hover:bg-black"}"
              @click=${() => {
                this.controller!.setMode(value);
                this.tick++;
              }}
            >
              ${label}
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderDirectory() {
    const players = this.callables();
    return html`
      <div class="flex flex-col gap-1">
        ${players.map((p) => {
          const id = p.clientID()!;
          const isBlocked = this.blocked.has(id);
          return html`
            <div class="flex items-center gap-1">
              <button
                class="flex-1 flex items-center gap-2 px-2 py-1 rounded bg-red-950 hover:bg-black text-left disabled:opacity-40"
                ?disabled=${isBlocked}
                @click=${() => this.controller!.dial(id)}
              >
                <span class="truncate">${p.displayName()}</span>
              </button>
              <button
                class="px-2 py-1 rounded text-xs ${isBlocked
                  ? "bg-yellow-400 text-black"
                  : "bg-red-950 hover:bg-black"}"
                title=${isBlocked
                  ? translateText("phone.unblock")
                  : translateText("phone.block")}
                @click=${() => this.toggleBlock(id)}
              >
                ${isBlocked ? "🔇" : "🚫"}
              </button>
            </div>
          `;
        })}
      </div>
    `;
  }

  // Blocks leben nur für dieses Match; der Server ist die Wahrheit, das Set
  // hier spiegelt sie nur für die Anzeige.
  private toggleBlock(id: string): void {
    if (this.blocked.has(id)) {
      this.blocked.delete(id);
      this.controller!.unblock(id);
    } else {
      this.blocked.add(id);
      this.controller!.block(id);
    }
    this.tick++;
  }

  private renderInCall() {
    const peers = this.controller!.machine.peers;
    return html`
      <div class="mb-2">
        <div class="text-xs opacity-80 mb-1">
          ${translateText("phone.in_call")}
        </div>
        ${peers.map(
          (id) =>
            html`<div class="px-2 py-1 rounded bg-red-950 mb-1">
              ${this.nameOf(id)}
            </div>`,
        )}
        <button
          class="w-full mt-1 px-2 py-1 rounded bg-red-950 hover:bg-black text-xs"
          @click=${() => this.controller!.toggleMute()}
        >
          ${this.controller!.muted
            ? translateText("phone.unmute")
            : translateText("phone.mute")}
        </button>
      </div>
      <div class="text-xs opacity-80 mb-1">${translateText("phone.call")}</div>
      ${this.renderDirectory()}
    `;
  }

  private renderMissed() {
    const missed = this.controller!.machine.missed;
    if (missed.length === 0) return html``;
    return html`
      <div class="mt-2 pt-2 border-t border-red-950">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs opacity-80"
            >${translateText("phone.missed_calls")}</span
          >
          <button
            class="text-xs px-2 py-0.5 rounded bg-red-950 hover:bg-black"
            @click=${() => this.controller!.machine.clearMissed()}
          >
            ✕
          </button>
        </div>
        ${missed.map(
          (mc) => html`<div class="text-xs opacity-90">${mc.username}</div>`,
        )}
      </div>
    `;
  }

  // Eigener Regler: Das Klingeln muss leiser drehbar sein, ohne den restlichen
  // Spiel-Sound mitzunehmen.
  private renderVolume() {
    return html`
      <div class="mt-2 pt-2 border-t border-red-950 flex items-center gap-2">
        <span class="text-xs opacity-80">${translateText("phone.volume")}</span>
        <input
          class="flex-1"
          type="range"
          min="0"
          max="1"
          step="0.05"
          .value=${String(this.controller!.volume)}
          @input=${(e: Event) => {
            this.controller!.setVolume(
              Number((e.target as HTMLInputElement).value),
            );
            this.tick++;
          }}
        />
      </div>
      <label class="mt-2 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          .checked=${this.controller!.alliesOnly}
          @change=${(e: Event) => {
            this.controller!.setAlliesOnly(
              (e.target as HTMLInputElement).checked,
            );
            this.tick++;
          }}
        />
        ${translateText("phone.allies_only")}
      </label>
    `;
  }

  private nameOf(clientID: string): string {
    const p = this.callables().find((x) => x.clientID() === clientID);
    return p?.displayName() ?? clientID;
  }
}
```

Prüfe die tatsächlichen Methodennamen auf `PlayerView` (`clientID()`, `displayName()`, `isPlayer()`) in `src/client/view.ts` bzw. `src/client/graphics/` und passe sie an, falls sie abweichen.

- [ ] **Step 2: Add the element to the page**

In `index.html` neben `<emoji-table></emoji-table>` (Zeile 361):

```html
<phone-widget></phone-widget>
```

- [ ] **Step 3: Wire it in GameRenderer**

In `src/client/hud/GameRenderer.ts` bei den anderen Layer-Verdrahtungen (Muster ab Zeile 75):

```typescript
const phoneWidget = document.querySelector("phone-widget") as PhoneWidget;
if (!phoneWidget || !(phoneWidget instanceof PhoneWidget)) {
  console.error("PhoneWidget element not found in the DOM");
}
const phoneController = new PhoneController(
  game.myPlayer()?.clientID() ?? "",
  transport,
  userSettings,
);
phoneWidget.init(phoneController, game);
```

Die Importe ergänzen und `phoneWidget` in die Layer-Liste (ab Zeile ~320) aufnehmen.

Wichtig: Die eingehenden Server-Nachrichten müssen den Controller erreichen. Suche die Stelle, an der `ServerMessage` verarbeitet wird (in `src/client/ClientGameRunner.ts` oder wo `onmessage` aus `Transport` verarbeitet wird), und ergänze:

```typescript
if (message.type === "phone") {
  phoneController.receive(message.payload);
}
```

- [ ] **Step 4: Typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: Keine Fehler.

- [ ] **Step 5: Verify in the running game**

Nutze die `run-openfront` Skill, um den Client zu starten und zu prüfen, dass das Telefon-Widget erscheint und aufklappt. Ein echter Anruf braucht zwei Clients — das ist Task 12.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/client/hud/layers/PhoneWidget.ts src/client/hud/GameRenderer.ts index.html
git commit -m "feat(phone): rotary phone overlay with directory and modes"
```

---

### Task 12: Manuelle Abnahme

Die Punkte, die sich nicht automatisiert prüfen lassen.

**Files:**

- Create: `docs/superpowers/plans/2026-08-08-telefonsystem-manual-test.md`

**Interfaces:**

- Consumes: das fertige Feature aus Tasks 1–11.
- Produces: eine abgehakte Testliste.

- [ ] **Step 1: Run the full automated suite**

```bash
npm test
npm run lint
```

Expected: Alles grün. Insbesondere dürfen keine Simulations-Tests brechen — wäre das der Fall, hätte die Telefonie die deterministische Schicht berührt und die Trennung wäre verletzt.

- [ ] **Step 2: Two-browser walkthrough**

Zwei Fenster, ein Match. Diese Liste abarbeiten und Ergebnisse notieren:

1. Anrufen, abheben, sprechen — Stimme kommt an und klingt nach Telefon (Höhen und Tiefen beschnitten)
2. Anruf abweisen — Anrufer hört Besetztzeichen
3. Anruf ignorieren — nach 12 s verpasster Anruf beim Angerufenen, Zähler am Mini-Telefon
4. DND einschalten, anrufen lassen — sofort Besetztzeichen, kein Klingeln
5. Lautlos einschalten — kein Klingelton, Anruf aber sichtbar und annehmbar
6. Dritten dazuwählen — Konferenz, alle drei hören sich gegenseitig
7. Mikrofon-Erlaubnis verweigern — hören ja, sprechen nein, Hinweis erscheint
8. Stummschalten im Gespräch — Gegenseite hört nichts mehr
9. Mitten im Gespräch das Match verlassen — die anderen telefonieren weiter
10. Während eines laufenden Anrufs weiterspielen — Karte bleibt bedienbar, nichts pausiert
11. Spieler blocken, dann von ihm anrufen lassen — Besetztzeichen, ununterscheidbar von DND
12. Klingel-Lautstärke herunterregeln — Klingeln wird leiser, restlicher Spiel-Sound unverändert
13. Verbündeten-Filter einschalten, von einem Nicht-Verbündeten anrufen lassen — Besetztzeichen

- [ ] **Step 3: Write down the results**

Erstelle `docs/superpowers/plans/2026-08-08-telefonsystem-manual-test.md` mit der Liste aus Schritt 2, je Punkt bestanden/nicht bestanden und Notizen. Bekannte Grenzen ausdrücklich festhalten: ohne TURN-Server scheitert die Verbindung für Spieler hinter strengen NATs — das ist erwartet und im Spec dokumentiert.

- [ ] **Step 4: Commit**

```bash
npm run format
git add docs/superpowers/plans/2026-08-08-telefonsystem-manual-test.md
git commit -m "docs(phone): manual acceptance results"
```
