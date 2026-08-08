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
      shaper.curve = saturationCurve(1.6) as any;
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
