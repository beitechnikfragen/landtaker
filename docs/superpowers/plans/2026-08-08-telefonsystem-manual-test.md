# Telefonsystem — Manuelle Abnahme

**Datum:** 2026-08-08
**Branch:** `claude/telefonsystem-spieler-anrufe-414d07`
**Spec:** `docs/superpowers/specs/2026-08-08-telefonsystem-design.md`
**Plan:** `docs/superpowers/plans/2026-08-08-telefonsystem.md`

## Automatisierte Tests

`npx vitest run` — **2757 bestanden**, 48 fehlgeschlagen.

Alle 48 Fehlschläge liegen in `tests/client/clan/*` und
`tests/client/ClanGameStatsNavigation.test.ts` und sind **vorbestehend**: Sie treten
identisch auf dem unveränderten Merge-Base-Commit `7c78dfdee` auf, überprüft in einem
separaten Worktree. Keine dieser Dateien referenziert Telefon-Code.

Kein einziger Fehlschlag stammt aus dem Telefonsystem. Insbesondere:

| Suite                                          | Ergebnis      |
| ---------------------------------------------- | ------------- |
| `tests/server/PhoneExchange.test.ts`           | 20 bestanden  |
| `tests/server/PhoneExchangeConference.test.ts` | 18 bestanden  |
| `tests/server/PhoneRateLimiter.test.ts`        | 6 bestanden   |
| `tests/PhoneSchemas.test.ts`                   | 7 bestanden   |
| `tests/PhoneCallStateMachine.test.ts`          | 20 bestanden  |
| `tests/PhoneSettings.test.ts`                  | 7 bestanden   |
| `tests/TranslationSystem.test.ts`              | 3 bestanden   |
| Gesamte Server-Suite                           | 353 bestanden |

`npx tsc --noEmit` ist sauber. Die Simulation (`src/core/game/`) wurde nie angefasst —
keine Sim-Tests brechen, was die architektonische Trennung bestätigt.

## Live-Prüfung im laufenden Spiel

Dev-Server (`npm run dev`, Port 9000), echter Browser, Singleplayer gegen Bots.
Vorgehen: vollständiger Reload (kein HMR — Lit-Custom-Elements lassen sich nicht neu
registrieren), dann Play → Single player → Spiel starten.

| #   | Prüfung                             | Ergebnis      | Beleg                                                                                                           |
| --- | ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Telefon erscheint im Spiel          | ✅            | 341 Zeichen gerendert, Badge 64×64 px bei (1200, 560), ☎️-Glyph vorhanden                                       |
| 2   | Controller ist verdrahtet           | ✅            | `phone-widget.controller` gesetzt, Zustand `idle`                                                               |
| 3   | Aufklappen per Klick                | ✅            | 341 → 1812 Zeichen, Apparat 448×161 px                                                                          |
| 4   | Drei Modus-Stellungen vorhanden     | ✅            | Normal / Silent / Do not disturb                                                                                |
| 5   | Modus-Umschaltung wirkt             | ✅            | `controller.mode`: `normal` → `dnd`                                                                             |
| 6   | Lautstärkeregler wirkt              | ✅            | `controller.volume`: 1 → 0.35                                                                                   |
| 7   | Verbündeten-Filter wirkt            | ✅            | `controller.alliesOnly`: false → true                                                                           |
| 8   | Einstellungen persistieren          | ✅            | localStorage: `phoneMode=dnd`, `phoneAlliesOnly=true`, `phoneVolume=0.35`                                       |
| 9   | **Overlay, kein Modal**             | ✅            | Vier Stichproben abseits des Telefons treffen weiterhin `#game-input-overlay`; Spiel läuft und bleibt bedienbar |
| 10  | Verzeichnis zeigt nur echte Spieler | ✅ (indirekt) | Im Bot-Spiel leer — Bots haben `clientID() === null`, werden also korrekt gefiltert                             |

**Zwei Fehler wurden durch diese Live-Prüfung gefunden und behoben** (siehe unten).

### Nicht abgedeckt

Ein echter Zwei-Browser-Anruf mit Sprachübertragung wurde **nicht** durchgeführt. Dazu
braucht es zwei menschliche Spieler in einem Match, Mikrofon-Hardware und
Mikrofon-Berechtigung — in dieser Umgebung nicht herstellbar. Ebenso konnte kein
Pixel-Screenshot erzeugt werden (die Browser-Pane kompositiert in diesem Harness keine
Frames); die Belege sind DOM-Messungen.

**Offen für einen Menschen zu prüfen** (die Zwei-Browser-Liste aus dem Spec):

1. Anrufen, abheben, sprechen — Stimme kommt an und klingt nach Telefon
2. Anruf abweisen — Anrufer hört Besetztzeichen
3. Anruf ignorieren — nach 12 s verpasster Anruf beim Angerufenen
4. DND, von außen anrufen lassen — sofort Besetztzeichen, kein Klingeln
5. Lautlos — kein Klingelton, Anruf aber sichtbar und annehmbar
6. Dritten dazuwählen — Konferenz, alle hören sich
7. Mikrofon verweigern — hören ja, sprechen nein, Hinweis erscheint
8. Stummschalten im Gespräch
9. Mitten im Gespräch das Match verlassen — die anderen telefonieren weiter
10. Spieler blocken, dann von ihm anrufen lassen — Besetztzeichen
11. Klingel-Lautstärke herunterregeln — nur das Telefon wird leiser

Die Serverlogik hinter den Punkten 2, 3, 4, 5, 6, 9 und 10 ist durch die 44
Exchange-Tests abgedeckt; offen ist die Audio-Strecke und das Zusammenspiel im echten
Netz.

## Während der Abnahme gefundene und behobene Fehler

### 1. Das Telefon war unsichtbar (blockierend)

`PhoneWidget.controller` und `.game` sind einfache Felder, keine reaktiven
`@state`-Felder. Das Element rendert einmal leer (beide noch `null`), `init()` setzt
danach die Felder — ohne ein Lit-Update auszulösen. Ergebnis: `innerHTML` blieb bei 15
Zeichen, Breite 0. Das Telefon war im Spiel schlicht nicht vorhanden, und da man es
weder sehen noch anklicken konnte, hätte auch nie ein Anruf den Zustand ändern können.

Nachgewiesen durch ein manuelles `requestUpdate()`, nach dem sofort korrekt gerendert
wurde (341 Zeichen, ☎️). Behoben mit `requestUpdate()` am Ende von `init()`
(Commit `42f20a102`) — die Felder bleiben bewusst nicht-reaktiv, da `GameView` den
gesamten Spielzustand hält.

### 2. Verbindungsfehler wurden nie gemeldet

`tests/TranslationSystem.test.ts` schlug fehl: Schlüssel `phone.no_connection` war
ungenutzt. Ursache war nicht der Schlüssel, sondern die fehlende Funktion dahinter —
`PhoneTransport` überwachte den Verbindungszustand überhaupt nicht. Das Spec verlangt
(Zeilen 75–80), dass ein Scheitern ehrlich als „keine Verbindung" gemeldet wird statt
endlos zu tuten, gerade weil ohne TURN-Server rund 10–15 % der Spieler hinter strengen
NATs nicht durchkommen.

Behoben (Commit `8cc485029`): `onconnectionstatechange` meldet `"failed"` an den
Controller (`"disconnected"` bewusst nicht, das ist oft nur eine kurze Störung), der es
über einen Getter anbietet; das Widget zeigt den Hinweis dort an, wo auch die
Mikrofon-Warnung erscheint. Das Flag wird bei jedem neuen Anruf zurückgesetzt.

## Bekannte Grenzen (aus dem Spec, keine Fehler)

- **Kein TURN-Server.** Spieler hinter strengen NATs/Firewalls kommen nicht zustande
  und sehen jetzt „keine Verbindung". Bewusste v1-Entscheidung.
- **Die sechs Sounddateien in `resources/sounds/phone/` sind Platzhalter** — reine
  Stille, mit ffmpeg erzeugt. Vor dem Release durch echte Aufnahmen ersetzen; die drei
  Loops (`ring`, `dial-tone`, `busy-tone`) brauchen einen nahtlosen Schnitt im
  Nulldurchgang.
- **Der Verbündeten-Filter greift außerhalb gerankter Matchmaking-Spiele nicht**, weil
  der Server dort keine Team-Information hat (Bündnisse leben in der Client-Simulation).
  Er fällt dann sicher aus: „niemand darf anrufen" statt versehentlich zu öffnen.
- **Mikrofon-Verweigerung ist eine Einbahnstraße** innerhalb einer Sitzung: Wer die
  Erlaubnis nachträglich erteilt, muss die Verbindung neu aufbauen.
- **Keine Aufzeichnung, nirgends** — Architektur, keine Einstellung.
