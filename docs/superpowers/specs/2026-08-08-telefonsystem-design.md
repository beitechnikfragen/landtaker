# Telefonsystem — Design

**Datum:** 2026-08-08
**Status:** Genehmigt, bereit für Implementierungsplanung

## Zusammenfassung

Statt Proximity Chat bekommt OpenFront ein diegetisches Telefonsystem: Spieler rufen
andere echte Spieler im laufenden Match an und sprechen per WebRTC miteinander. Das
UI ist ein rotes Wählscheiben-Telefon mit vollem Sound-Design, die Stimme des
Gegenübers läuft durch eine Telefon-Klangkette (Bandpass ~300 Hz – 3,4 kHz plus
Kompression und Sättigung). Es gibt Erreichbarkeits-Modi (Normal / Lautlos / DND),
Konferenzen bis sechs Teilnehmer und verpasste Anrufe.

Anrufe existieren nur innerhalb eines Matches. Es gibt keine matchübergreifende
Telefonie.

## Zielbild

Das Telefon soll sich nach einem Gegenstand anfühlen, nicht nach einem Voice-Chat-
Panel. Die Wählscheibe dreht, der Hörer fällt auf die Gabel, die Glocke klingelt, das
Besetztzeichen tutet. Der Effekt auf der Stimme ist Teil des Erlebnisses, nicht
Kosmetik.

## Architektur

### Grundprinzip: Telefonie berührt die Simulation nicht

`src/core/` bleibt unangetastet. Anrufe sind kein Spielzustand: Sie sind nicht
deterministisch, gehören nicht in Replays und dürfen den Sim-Hash nicht beeinflussen.
Telefon-Nachrichten laufen deshalb als **eigene Message-Familie** an der
Intent/Turn-Pipeline vorbei — sie werden nie zu Intents und nie in einen Turn gepackt.

Diese Disziplin ist gleichzeitig die Migrationsversicherung: Wenn Signaling später auf
einen eigenen Service oder eine SFU umzieht, wird nur der Transport getauscht.
Zustandsautomat, UI und Sound-Design bleiben unangetastet.

### Signaling: über die bestehende Game-WebSocket

Neue Zod-Schemas in `src/core/Schemas.ts` (Telefon-Nachrichten, kein Intent-Typ). Der
GameServer erkennt sie und reicht sie an die Vermittlungsstelle durch; deren
Ausgangs-Nachrichten gehen an die betroffenen Sockets.

Begründung gegenüber einem eigenen Signaling-Service: Signaling ist billig (ca. 10–20
kleine Nachrichten pro Anruf, danach null Server-Traffic, weil Audio direkt P2P
fließt). Ein separater Endpunkt würde eine zweite Verbindung, erneute Auth und erneute
Lobby-Zuordnung bedeuten, ohne Gegenwert — insbesondere da Anrufe match-gebunden sind.

### Serverseitig: `src/server/PhoneExchange.ts` (Vermittlungsstelle)

Eine schmale Einheit pro Match. Sie kennt:

- die aktiven Gespräche und ihre Teilnehmer,
- pro Spieler: Modus (Normal / Lautlos / DND), Verbündeten-Filter, Block-Liste.

Sie ist die **einzige** Stelle, die entscheidet, ob ein Anruf durchgestellt wird. Diese
Prüfung passiert serverseitig, weil ein manipulierter Client sonst DND und Blocks
schlicht ignorieren könnte.

Der GameServer bekommt nur wenige Zeilen: Nachricht erkennen, weiterreichen, Ausgabe
zustellen.

Identität läuft über die bestehenden Client-/Player-IDs des Matches. Es gibt keine
separaten Telefonnummern — die Wählscheibe animiert beim Anwählen nur dekorativ eine
Ziffernfolge durch.

### Clientseitig: drei getrennte Einheiten

1. **Call-State-Automat** — kennt nur Zustände und erlaubte Übergänge. Weiß nichts von
   WebRTC und nichts von UI. Ohne Browser, Mikrofon oder Netzwerk testbar.
2. **Transport-Schicht** — verwaltet die `RTCPeerConnection`s, holt den
   Mikrofon-Stream, legt die Telefon-Klangkette an.
3. **Lit-Komponenten** — das Telefon-Overlay. Beobachtet den Automaten und rendert.

### WebRTC-Realität

STUN über öffentliche Server. **Kein eigener TURN-Server in v1.** Für die ~10–15 % der
Spieler hinter strengen NATs/Firewalls kommt damit keine Verbindung zustande; das wird
ehrlich als "keine Verbindung" gemeldet statt endlos zu tuten. TURN (coturn oder
gehostet) kann später ergänzt werden, ohne das Design zu ändern.

## Anruf-Regeln und Zustände

### Zustände

Ein Spieler ist in genau einem Zustand:

| Zustand             | Bedeutung                                               |
| ------------------- | ------------------------------------------------------- |
| Aufgelegt (idle)    | Nichts los                                              |
| Ich rufe an         | Freizeichen tutet, beim Gegenüber klingelt es           |
| Es klingelt bei mir | Eingehender Anruf steht an                              |
| Im Gespräch         | Verbunden (1:1 oder Konferenz)                          |
| Besetzt             | Tuut-Tuut nach abgewiesenem Anruf, läuft von selbst aus |

### Prüfkette beim Anwählen

Die Vermittlungsstelle prüft der Reihe nach:

1. Ist das Ziel noch im Match und verbunden?
2. Hat das Ziel DND an?
3. Hat das Ziel den Anrufer geblockt?
4. Hat das Ziel den Verbündeten-Filter an und der Anrufer ist keiner?
5. Sitzt das Ziel bereits in einem Gespräch? (Es geht um das **Ziel**, nicht um den
   Anrufer — beim Dazuwählen sitzt der Anrufer ja selbst in einem Call.)
6. Ist der Call, in den gewählt wird, bereits bei sechs Teilnehmern?

Bei jedem Nein bekommt der Anrufer **dasselbe Besetztzeichen**. Das ist bewusst
ununterscheidbar: Sonst ließe sich durch Ausprobieren herausfinden, ob man geblockt
wurde oder das Gegenüber nur gerade telefoniert.

Die Prüfkette ist für beide Fälle dieselbe — den ersten Anruf (der einen neuen Call mit
zwei Teilnehmern eröffnet) und das Dazuwählen in einen bestehenden Call. Der einzige
Unterschied liegt in Schritt 6, der beim ersten Anruf trivial erfüllt ist.

### Modi

- **Normal** — klingelt hörbar und visuell.
- **Lautlos** — kein Klingelton, aber der Anruf kommt an und blinkt visuell; man kann
  rangehen. Der Anrufer merkt keinen Unterschied.
- **DND** — Anruf wird nicht durchgestellt, Anrufer bekommt sofort Besetztzeichen.

### Timeout und verpasste Anrufe

Ein unbeantworteter Anruf läuft nach **12 Sekunden** aus (ca. vier bis fünf
Klingelzeichen). Der Wert ist auf das schnelle Spieltempo abgestimmt: lang genug, um
zwischen zwei Aktionen rangehen zu können, kurz genug, dass ein Anruf sich nicht wie
eine Strafe anfühlt.

Verpasste Anrufe (Timeout oder Anrufer legt vorher auf) landen mit Anrufer und
Zeitpunkt in einer Liste, sichtbar als Zähler am Telefon-Widget. Aktives Abweisen gibt
dem Anrufer sofort das Besetztzeichen.

**Der Anrufer ist während des Tutens nicht blockiert.** Das Spiel läuft darunter weiter
und bleibt bedienbar. Sonst wäre jeder Anrufversuch ein Gameplay-Risiko.

### Konferenz

Bis **sechs Teilnehmer**, als **Mesh** (jeder mit jedem verbunden, kein Media-Server).
Der Browser mischt die eingehenden Streams von selbst. Bei dieser Gruppengröße ist die
Upload-Last vertretbar.

- Jeder Teilnehmer kann weitere Spieler dazuwählen. Es gibt **keinen Host** — der Call
  gehört allen gemeinsam.
- Beim Dazugeholten klingelt es normal; alle Regeln greifen unverändert.
- **Blocks werden gegenüber jedem Teilnehmer geprüft**, nicht nur gegenüber dem
  Anwählenden. Wer C geblockt hat, wird nicht in einen Call mit C gezogen; und C wird
  nicht in einen Call geholt, in dem jemand sitzt, der C blockiert. Ohne diese Regel
  wäre der Block über den Umweg Konferenz trivial umgehbar.
- Der **Verbündeten-Filter** gilt dagegen nur gegenüber dem Anwählenden, nicht
  gegenüber allen Teilnehmern. Er ist eine Erreichbarkeits-Einstellung ("wer darf mich
  anklingeln"), keine Aussage darüber, mit wem man im selben Raum sitzen möchte. Wer
  wirklich niemanden hören will, legt auf oder nutzt Block.
- **Niemand kann jemanden rauswerfen.** Wer nicht mehr mag, legt auf.
- Legt der vorletzte auf, endet der Call auch für den letzten.
- Klingelt es bei einem Dazugeholten und der Anwählende legt in der Zwischenzeit selbst
  auf, läuft der Ruf trotzdem weiter — er gilt dem Call, nicht der Person. Nimmt der
  Gerufene an, landet er beim Rest der Runde. Nur wenn der Call vorher komplett endet,
  wird der laufende Ruf abgebrochen und als verpasster Anruf verbucht.

Beim Beitritt baut der Dazugeholte Peer-Verbindungen zu **allen** bestehenden
Teilnehmern auf. Die Vermittlungsstelle schickt ihm die Teilnehmerliste. Wer jeweils
das Offer stellt, muss eindeutig festgelegt sein (Regel: die kleinere Client-ID stellt
das Offer), sonst kollidieren gleichzeitige Verbindungsaufbauten.

### Verbindungsabbruch

Verliert jemand die Verbindung oder verlässt das Match, räumt die Vermittlungsstelle
ihn aus dem Call. Die anderen hören ein kurzes Klicken und telefonieren weiter.

## UI: Das Telefon

### Zwei Größen

Klein am Bildschirmrand: rotes Wählscheiben-Telefon, ruhig, mit Zähler für verpasste
Anrufe. Bei Klick oder eingehendem Anruf klappt es groß auf (ca. ein Drittel bis die
Hälfte der Bildschirmhöhe).

**Es ist ein Overlay, kein Modal.** Das Spiel bleibt sichtbar und bedienbar, pausiert
nie, und der Fokus wird nie geraubt.

### Elemente am aufgeklappten Apparat

- **Anruferliste** (links): alle echten Spieler des Matches mit Name und Farbe, dazu
  ein Indikator für erreichbar / telefoniert gerade. Bots und Nations erscheinen nicht.
  Von hier wird angewählt und während eines Gesprächs dazugeholt.
- **Drehschalter** mit drei Stellungen für Normal / Lautlos / DND — physisch mit
  spürbarem Einrasten, kein Dropdown.
- **Notizblock** mit den verpassten Anrufen.
- **Stummschalt-Knopf** am Apparat (nicht in einem versteckten Menü).

### Animationen

- Anwählen: Wählscheibe dreht durch und schnappt mit der Ratsche zurück, einmal pro
  Ziffer.
- Abnehmen: Hörer hebt sich von der Gabel, Schnur schwingt träge nach.
- Eingehender Anruf: Apparat vibriert im Takt der Glocke, Hörer hüpft minimal.
- Auflegen: Hörer fällt hörbar zurück auf die Gabel.
- Im Gespräch: nichts Hektisches — nur leichtes Pulsieren an den Teilnehmern in der
  Liste, sobald jemand spricht.

## Audio

Zwei strikt getrennte Ebenen.

### Ebene 1: Telefon-Geräusche (Howler.js)

Wählscheiben-Ratsche, Freizeichen, Besetzt-Tuten, Klingelglocke, Knacken beim Abheben,
Klacken beim Auflegen. Laufen wie der übrige Spiel-Sound über Howler und respektieren
die bestehende Lautstärke-Einstellung — **mit eigenem Regler**, denn ein Klingeln, das
man nicht leiser drehen kann, ist eine Zumutung.

### Ebene 2: Die Stimme (Web Audio API)

Nicht über Howler. Eigene Kette am eingehenden WebRTC-Stream, vor der Ausgabe:

1. Hochpass ~300 Hz, steile Flanke
2. Tiefpass ~3,4 kHz, steile Flanke
3. Leichte Kompression
4. Dezente Sättigung

Ziel ist, dass die Stimme nach Leitung klingt, nicht nach Discord mit EQ. Die Kette
existiert **pro Teilnehmer eigenständig**, sodass in der Konferenz jeder durch dieselbe
Leitung kommt.

### Mikrofon

Beim ersten Anruf fragt der Browser um Erlaubnis — unvermeidbar. Wird sie verweigert,
bleibt das Telefon nutzbar: man hört die anderen, spricht aber nicht, und das Telefon
zeigt das ehrlich an.

Beim Abheben ist das Mikrofon **offen** (bei einem Telefon wäre alles andere
unnatürlich). Stummschaltung ist jederzeit möglich.

## Einstellungen und Persistenz

Über `UserSettings` (localStorage) dauerhaft gespeichert:

- Telefon-Modus (Normal / Lautlos / DND)
- Verbündeten-Filter
- Lautstärke der Telefon-Geräusche

Der Client meldet diese Präferenzen beim Betreten eines Matches einmal an die
Vermittlungsstelle und bei jeder Änderung erneut, da die Prüfung serverseitig
stattfindet.

**Blocks gelten nur für das laufende Match** und verschwinden danach. Eine dauerhafte
Blockliste bräuchte Account-Persistenz und gehört in die geschlossene API, nicht
hierher. Das ist eine bewusste Lücke, kein Versehen.

**Telefonie ist standardmäßig aktiviert.** Man ist also standardmäßig erreichbar und es
klingelt. Da der Browser ohnehin beim ersten Anruf um Mikrofon-Erlaubnis fragt, kann
niemand unbemerkt mit offenem Mikrofon dasitzen.

## Moderation — bekannte Grenzen

Dies ist ein **unmoderierter Sprachkanal zwischen Fremden**. Das Spiel hat mit
`Censor.ts` einen Textfilter; für Audio gibt es kein Äquivalent. Gesprochenes ist nicht
protokollierbar und nicht durchsuchbar, und ein Teil der Spielerschaft wird
minderjährig sein.

Die vorhandenen Werkzeuge — Block, DND, Verbündeten-Filter — sind das Minimum, nicht
die Lösung. Das wird hier explizit festgehalten, damit es eine bewusste Entscheidung
bleibt.

**Keine Aufzeichnung, nirgends.** Peer-to-Peer, kein Server sieht das Audio, und es
wird kein Weg gebaut, das zu ändern. Das ist keine Einstellung, sondern Architektur.

**Kein Melde-Knopf in v1.** Ohne Aufzeichnung und ohne Backend-Anbindung wäre er reine
Deko. Ein echtes Meldesystem führt über die API und braucht Meldungen mit Zeitstempel
und Match-ID, die ein Mensch auswertet.

**Hinweis, kein Rechtsrat:** Sobald Voice zwischen Nutzern läuft, berühren Themen wie
Altersgrenzen und Nutzungsbedingungen das Projekt anders als bei Textchat. Das sollte
das Team einmal bewusst prüfen.

## Testing

### Automatisiert (Vitest)

**Call-State-Automat** — reine Logik, gefakte Uhr, keine WebRTC-Mocks nötig:

- Anruf raus → angenommen
- Anruf raus → abgelehnt → Besetztzeichen
- Timeout nach 12 Sekunden → verpasster Anruf
- Konferenz-Übergänge (2 → 3 → 4 Teilnehmer)
- Letzter Teilnehmer legt auf → Call endet

**Vermittlungsstelle** — der sicherheitsrelevante Teil, dichteste Abdeckung. Nachrichten
rein, Nachrichten raus:

- DND → Besetztzeichen
- Block → Besetztzeichen
- Block greift auch über die Konferenz (in beide Richtungen)
- Verbündeten-Filter → Besetztzeichen bei Nicht-Verbündetem
- Voller Call (6 Teilnehmer) → Besetztzeichen
- Ziel telefoniert bereits → Besetztzeichen
- Anrufer telefoniert bereits → **kein** Besetztzeichen, sondern Dazuwählen
- Verbündeten-Filter greift nur gegenüber dem Anwählenden, nicht gegenüber den übrigen
  Teilnehmern
- Anwählender legt auf, während es beim Dazugeholten noch klingelt → Ruf läuft weiter
- Call endet, während es beim Dazugeholten noch klingelt → Ruf bricht ab, verpasster
  Anruf
- Disconnect räumt den Teilnehmer sauber aus dem Call

`src/core/` bleibt unangetastet, dort gibt es nichts zu testen — was gleichzeitig die
Bestätigung ist, dass die Trennung stimmt.

### Manuell

Nicht sinnvoll automatisierbar: echte WebRTC-Verbindungen, die Klangkette, und ob das
Telefon sich gut anfühlt. Peer-Verbindungen zwischen zwei echten Browsern in CI
aufzubauen ist ein eigenes Projekt und den Aufwand nicht wert.

Manuelle Testliste (zwei Browser-Fenster, ein Match):

1. Anrufen, abheben, sprechen — Stimme kommt an und klingt nach Telefon
2. Anruf abweisen — Anrufer hört Besetztzeichen
3. Anruf ignorieren — nach 12 s verpasster Anruf beim Angerufenen
4. DND einschalten, anrufen lassen — sofort Besetztzeichen
5. Lautlos einschalten — kein Klingelton, aber Anruf sichtbar und annehmbar
6. Dritten dazuwählen — Konferenz, alle hören sich
7. Mikrofon-Erlaubnis verweigern — hören ja, sprechen nein, ehrliche Anzeige
8. Stummschalten im Gespräch
9. Mitten im Gespräch das Match verlassen — die anderen telefonieren weiter

## i18n

Alle sichtbaren Texte laufen über `translateText()` mit Einträgen in
`resources/lang/en.json`. Keine anderen Übersetzungsdateien anfassen (Crowdin).

## Explizit nicht in v1

- Matchübergreifende Anrufe
- Eigener TURN-Server
- SFU / Konferenzen über sechs Teilnehmer
- Manuelles Wählen per Wählscheibe (Nummern eingeben)
- Dauerhafte Blocklisten über Matches hinweg
- Melde-Funktion
- Aufzeichnung in jeder Form (dauerhaft ausgeschlossen, nicht nur v1)
