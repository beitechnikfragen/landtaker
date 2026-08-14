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
  // Wann das Zeitlimit abläuft — gesetzt beim ERSTEN Verbinden, also wenn
  // aus dem Klingeln ein Gespräch wird. null, solange nur geklingelt wird:
  // Klingelzeit ist keine Gesprächszeit und darf das Budget nicht anknabbern
  // (der Ruf hat dafür sein eigenes RING_TIMEOUT_MS). Die Frist gehört dem
  // CALL, nicht der Person: wer später dazukommt, erbt den Rest.
  expiresAt: number | null;
}
