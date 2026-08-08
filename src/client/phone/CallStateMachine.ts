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
