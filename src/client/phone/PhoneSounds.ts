import { Howl } from "howler";
import { assetUrl } from "../../core/AssetUrls";

type LoopName = "ring" | "dial-tone" | "busy-tone";
type ToneName = "dial-tone" | "busy-tone";
type OneShotName = "dial-click" | "pick-up" | "hang-up";

// Only "ring" is still a shipped file. It must be a seamless loop: cut at a
// zero-crossing (or, as delivered, at a silent stretch of its own ring
// cadence) so Howler's `loop: true` can repeat it with no audible click or
// gap. dial-tone and busy-tone are synthesized in code (see ToneSynth below)
// rather than shipped as files — see the constants block for why.
const LOOP_URLS: Record<"ring", string> = {
  ring: assetUrl("sounds/phone/ring.mp3"),
};

// dial-click, pick-up and hang-up remain silent ffmpeg-generated placeholders.
// The user deliberately chose to leave these three out of this pass; do not
// synthesize them here.
const ONE_SHOT_URLS: Record<OneShotName, string> = {
  "dial-click": assetUrl("sounds/phone/dial-click.mp3"),
  "pick-up": assetUrl("sounds/phone/pick-up.mp3"),
  "hang-up": assetUrl("sounds/phone/hang-up.mp3"),
};

// As in SoundManager: slider positions are linear, but perceived loudness
// isn't, so we square the position for an audio-taper curve. PhoneSounds
// keeps its own copy rather than importing SoundManager's private helper —
// this volume is deliberately independent of the sound-effects slider,
// because a ring you can't turn down is intolerable.
function perceptualGain(position: number): number {
  const clamped = Math.max(0, Math.min(1, position));
  return clamped * clamped;
}

// --- Synthesized dial tone / busy tone -------------------------------------
//
// Deutsches/europäisches Wählton-Schema: 425 Hz Sinus.
// Freizeichen (dial tone, wie der Anrufer es hört): 1 s an, 4 s aus.
// Besetztzeichen (busy tone): 480 ms an, 480 ms aus.
// Beide Werte sind absichtlich benannt und exportierbar, damit sie sich ohne
// Grabung im Signalgraphen abstimmen lassen.
const TONE_FREQUENCY_HZ = 425;
const DIAL_TONE_ON_SECONDS = 1;
const DIAL_TONE_OFF_SECONDS = 4;
const BUSY_TONE_ON_SECONDS = 0.48;
const BUSY_TONE_OFF_SECONDS = 0.48;

// Weiche Flanken statt hartem An/Aus: ein paar Millisekunden Attack/Release
// pro Burst killen das Klicken, das ein rechteckig ein-/ausgeschaltener
// Sinus sonst an jeder Flanke erzeugt.
const TONE_RAMP_SECONDS = 0.008;

// Etwas bandbegrenztes Rauschen unter dem Ton verkauft die "Leitung" — ein
// nackter Sinus klingt sofort nach Synthesizer, nicht nach Telefonnetz.
const TONE_NOISE_LEVEL = 0.015;
const TONE_NOISE_BUFFER_SECONDS = 2;

// Gleiches Fernsprechband wie in PhoneAudio.ts, damit die Töne klanglich zur
// gefilterten Stimme passen statt wie ein sauberer Systemton daneben zu stehen.
const TONE_HIGHPASS_HZ = 300;
const TONE_LOWPASS_HZ = 3400;
const TONE_FILTER_Q = 0.9;

// Wie weit im Voraus eine Burst-Cadence geplant wird. Die eigentlichen
// An/Aus-Flanken sind exakte AudioParam-Automation (sample-genaue Zeiten);
// nur die Entscheidung "plane den nächsten Block" läuft über einen Timer —
// das ist das übliche Lookahead-Scheduler-Muster für Web Audio und vermeidet
// den Drift, den `setInterval`-getriebene Klangerzeugung sonst hätte.
const SCHEDULE_AHEAD_SECONDS = 0.5;
const SCHEDULER_INTERVAL_MS = 100;

interface ToneCadence {
  onSeconds: number;
  offSeconds: number;
}

const TONE_CADENCE: Record<ToneName, ToneCadence> = {
  "dial-tone": {
    onSeconds: DIAL_TONE_ON_SECONDS,
    offSeconds: DIAL_TONE_OFF_SECONDS,
  },
  "busy-tone": {
    onSeconds: BUSY_TONE_ON_SECONDS,
    offSeconds: BUSY_TONE_OFF_SECONDS,
  },
};

// Erzeugt einen leisen, bandbegrenzten Rauschpuffer (siehe PhoneAudio.ts für
// dieselbe Technik: einfache Tiefpass-Integration über weißes Rauschen).
function createNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.max(
    1,
    Math.floor(ctx.sampleRate * TONE_NOISE_BUFFER_SECONDS),
  );
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.08 * white) / 1.08;
    data[i] = last * 3.5;
  }
  return buffer;
}

// Ein laufender Oszillator + eine gescheduelte Gain-Hüllkurve pro Tonart.
// Läuft dauerhaft (der Oszillator selbst kennt keine Pausen); die An/Aus-
// Kadenz entsteht ausschließlich über geplante Gain-Rampen.
class ToneSynth {
  private readonly ctx: AudioContext;
  private readonly oscillator: OscillatorNode;
  private readonly toneGain: GainNode;
  private readonly noiseSource: AudioBufferSourceNode;
  private readonly noiseGain: GainNode;
  private readonly filters: BiquadFilterNode[];
  private schedulerHandle: ReturnType<typeof setInterval> | null = null;
  private nextBurstStart = 0;
  private disposed = false;

  constructor(
    ctx: AudioContext,
    destination: AudioNode,
    private readonly cadence: ToneCadence,
  ) {
    this.ctx = ctx;

    this.oscillator = ctx.createOscillator();
    this.oscillator.type = "sine";
    this.oscillator.frequency.value = TONE_FREQUENCY_HZ;

    this.toneGain = ctx.createGain();
    this.toneGain.gain.value = 0;

    this.noiseSource = ctx.createBufferSource();
    this.noiseSource.buffer = createNoiseBuffer(ctx);
    this.noiseSource.loop = true;

    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = TONE_NOISE_LEVEL;

    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = TONE_HIGHPASS_HZ;
    highpass.Q.value = TONE_FILTER_Q;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = TONE_LOWPASS_HZ;
    lowpass.Q.value = TONE_FILTER_Q;

    this.filters = [highpass, lowpass];

    // Sinus und Rauschen laufen getrennt bis zum gemeinsamen Bandfilter,
    // damit das Rauschen dieselbe Kadenz (Gain-Hüllkurve) mitbekommt wie der
    // Ton selbst — sonst würde es während der Pausen durchlaufen. Die
    // Lautstärke selbst wird nicht hier, sondern eine Stufe weiter oben im
    // `destination`-Gain (PhoneSounds.toneMaster) geregelt — der bleibt über
    // Tonwechsel hinweg bestehen, damit setVolume() auch ohne aktiven Ton
    // sofort für den nächsten Ton gilt.
    this.oscillator.connect(this.toneGain);
    this.noiseSource.connect(this.noiseGain);
    this.toneGain.connect(highpass);
    this.noiseGain.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(destination);

    this.oscillator.start();
    this.noiseSource.start();

    this.nextBurstStart = ctx.currentTime + 0.02;
    this.scheduleAhead();
    this.schedulerHandle = setInterval(
      () => this.scheduleAhead(),
      SCHEDULER_INTERVAL_MS,
    );
  }

  // Plant jede Burst-Hüllkurve, deren Startzeit innerhalb des Lookahead-
  // Fensters liegt, exakt als AudioParam-Automation auf der Gain-Kurve.
  private scheduleAhead(): void {
    if (this.disposed) return;
    const horizon = this.ctx.currentTime + SCHEDULE_AHEAD_SECONDS;
    while (this.nextBurstStart < horizon) {
      this.scheduleBurst(this.nextBurstStart);
      this.nextBurstStart += this.cadence.onSeconds + this.cadence.offSeconds;
    }
  }

  private scheduleBurst(startTime: number): void {
    const rampEnd = Math.min(TONE_RAMP_SECONDS, this.cadence.onSeconds / 2);
    const sustainEnd = startTime + this.cadence.onSeconds - rampEnd;
    const burstEnd = startTime + this.cadence.onSeconds;

    const g = this.toneGain.gain;
    g.setValueAtTime(0, startTime);
    g.linearRampToValueAtTime(1, startTime + rampEnd);
    g.setValueAtTime(1, sustainEnd);
    g.linearRampToValueAtTime(0, burstEnd);
  }

  // Stoppt sofort: kappt die Gain-Automation ab jetzt, hält bei 0 und
  // beendet Oszillator/Rauschquelle. Nach dispose() läuft nichts mehr.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.schedulerHandle !== null) {
      clearInterval(this.schedulerHandle);
      this.schedulerHandle = null;
    }
    const now = this.ctx.currentTime;
    try {
      this.toneGain.gain.cancelScheduledValues(now);
      this.toneGain.gain.setValueAtTime(0, now);
    } catch {
      // Node may already be in a bad state during teardown; ignore.
    }
    for (const node of [this.oscillator, this.noiseSource] as const) {
      try {
        node.stop();
      } catch {
        // Already stopped / never started.
      }
    }
    for (const node of [
      this.oscillator,
      this.toneGain,
      this.noiseSource,
      this.noiseGain,
      ...this.filters,
    ]) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }
}

export class PhoneSounds {
  private loops = new Map<"ring", Howl>();
  private oneShots = new Map<OneShotName, Howl>();
  private active: LoopName | null = null;
  private volume = 1;

  // Der AudioContext für die synthetisierten Töne wird erst bei Bedarf
  // erzeugt: Browser blockieren Audio vor einer Nutzerinteraktion, und ein
  // vorab erzeugter Context würde nur "suspended" herumliegen.
  private toneCtx: AudioContext | null = null;
  private toneMaster: GainNode | null = null;
  private activeTone: ToneSynth | null = null;

  constructor(volume: number) {
    this.volume = perceptualGain(volume);
  }

  setVolume(position: number): void {
    this.volume = perceptualGain(position);
    for (const howl of this.loops.values())
      this.safely("set loop volume", () => howl.volume(this.volume));
    for (const howl of this.oneShots.values())
      this.safely("set one-shot volume", () => howl.volume(this.volume));
    // toneMaster persists across tone start/stop (created lazily, closed only
    // in dispose()), so this applies immediately even with no tone playing —
    // the next startDialTone()/startBusyTone() picks it up automatically.
    this.safely("set tone volume", () => {
      if (this.toneMaster && this.toneCtx)
        this.toneMaster.gain.setValueAtTime(
          this.volume,
          this.toneCtx.currentTime,
        );
    });
  }

  startRinging(): void {
    this.stopActiveTone();
    this.startLoop("ring");
  }

  startDialTone(): void {
    this.startTone("dial-tone");
  }

  startBusyTone(): void {
    this.startTone("busy-tone");
  }

  stopAll(): void {
    this.stopActiveTone();
    if (!this.active) return;
    this.safely("stop loop", () => this.loops.get("ring")?.stop());
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

    this.safely("dispose tone synth", () => this.activeTone?.dispose());
    this.activeTone = null;
    this.toneMaster = null;
    if (this.toneCtx) {
      const ctx = this.toneCtx;
      this.toneCtx = null;
      this.safely("close tone context", () => void ctx.close());
    }
  }

  // Only one loop/tone plays at a time: starting one stops whichever of the
  // Howler ring or the synthesized tones was previously active.
  private startLoop(name: "ring"): void {
    if (this.active === name) return;
    this.stopHowlerLoop();
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

  private startTone(name: ToneName): void {
    if (this.active === name) return;
    this.stopHowlerLoop();
    this.stopActiveTone();
    this.safely(`play ${name}`, () => {
      const ctx = this.ensureToneContext();
      const master = this.toneMaster;
      if (!ctx || !master) return;
      // Browsers create AudioContext in "suspended" state until a user
      // gesture unlocks it; startDialTone()/startBusyTone() are always
      // called from within a call flow the user already initiated (dialing,
      // answering), so resuming here is safe and quiet if already running.
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      this.activeTone = new ToneSynth(ctx, master, TONE_CADENCE[name]);
      this.active = name;
    });
  }

  private ensureToneContext(): AudioContext | null {
    if (this.toneCtx) return this.toneCtx;
    const Ctor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : // Safari fallback.
          (globalThis as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.volume;
    master.connect(ctx.destination);
    this.toneCtx = ctx;
    this.toneMaster = master;
    return ctx;
  }

  private stopHowlerLoop(): void {
    if (this.active !== "ring") return;
    this.safely("stop loop", () => this.loops.get("ring")?.stop());
    this.active = null;
  }

  private stopActiveTone(): void {
    if (!this.activeTone) {
      if (this.active === "dial-tone" || this.active === "busy-tone")
        this.active = null;
      return;
    }
    this.safely("stop tone", () => this.activeTone?.dispose());
    this.activeTone = null;
    this.active = null;
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
