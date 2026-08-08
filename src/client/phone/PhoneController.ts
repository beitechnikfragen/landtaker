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
  private _connectionFailed = false;
  private unsubscribe: () => void;

  constructor(
    myId: ClientID,
    private readonly transport: Transport,
    private readonly userSettings: UserSettings,
  ) {
    this.sounds = new PhoneSounds(userSettings.phoneVolume());
    this.rtc = new PhoneTransport(
      myId,
      (to, data) => {
        // TEMP diagnostics: remove once the phone audio bug is found
        let innerType = "unknown";
        try {
          innerType = JSON.parse(data).type;
        } catch {
          // ignore parse failure, keep "unknown"
        }
        console.log(`[phone] outbound signal to=${to} innerType=${innerType}`);
        this.send({ kind: "signal", to, data });
      },
      () => {
        this._connectionFailed = true;
      },
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

  // STUN-only in v1: no TURN server means some peers behind strict NATs
  // never connect. This surfaces that honestly instead of ringing forever.
  get connectionFailed(): boolean {
    return this._connectionFailed;
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
    // TEMP diagnostics: remove once the phone audio bug is found
    if (payload.kind === "callState") {
      console.log(
        `[phone] PhoneController.receive kind=${payload.kind} peers.length=${payload.peers.length} peers=${JSON.stringify(payload.peers)}`,
      );
    } else if (payload.kind === "ringing" || payload.kind === "missed") {
      console.log(
        `[phone] PhoneController.receive kind=${payload.kind} from=${payload.from}`,
      );
    } else {
      console.log(`[phone] PhoneController.receive kind=${payload.kind}`);
    }
    if (payload.kind === "signal") {
      void this.rtc.handleSignal(payload.from, payload.data);
      return;
    }
    if (payload.kind === "ringing") {
      this._connectionFailed = false;
    }
    this.machine.receive(payload);
    if (payload.kind === "callState") {
      void this.rtc.syncPeers(payload.peers);
    } else if (payload.kind === "callEnded") {
      void this.rtc.syncPeers([]);
    }
  }

  dial(target: ClientID): void {
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(`[phone] PhoneController.dial target=${target}`);
    this._connectionFailed = false;
    this.sounds.playDialClick();
    this.send({ kind: "dial", target });
  }

  answer(): void {
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(`[phone] PhoneController.answer`);
    this._connectionFailed = false;
    this.sounds.playPickUp();
    this.send({ kind: "answer" });
  }

  hangup(): void {
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(`[phone] PhoneController.hangup`);
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
    // TEMP diagnostics: remove once the phone audio bug is found
    console.log(`[phone] PhoneController.send OUT kind=${payload.kind}`);
    this.transport.sendPhone(payload);
  }
}
