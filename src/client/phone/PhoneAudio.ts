// Klassisches Fernsprechband: unter 300 Hz und über 3,4 kHz ist nichts.
const HIGHPASS_HZ = 300;
const LOWPASS_HZ = 3400;
const FILTER_Q = 0.9;
// Mehrere Stufen kaskadiert ergeben eine deutlich steilere Flanke
// (12 dB/Oktave je Stufe) statt des dünnen Single-Biquad-EQs.
const HIGHPASS_STAGES = 3;
const LOWPASS_STAGES = 3;

// Präsenz-Anhebung um 1-2 kHz: der nasale, "boxy" Ton typischer Hörer.
const PRESENCE_HZ = 1500;
const PRESENCE_GAIN_DB = 6;
const PRESENCE_Q = 1.1;

// Sättigungsstärke: hoch genug, dass die Stimme unter Last leicht knirscht,
// aber bei normaler Sprechlautstärke nicht verzerrt oder ermüdend wirkt.
const SATURATION_AMOUNT = 3.2;

// Leitungsrauschen: leise, bandbegrenzte Geräuschspur unter der Stimme.
const NOISE_LEVEL = 0.02;
const NOISE_BUFFER_SECONDS = 2;

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

// Erzeugt einen leise loopenden Rauschpuffer mit leichtem Pink-Noise-Einschlag
// (einfache Tiefpass-Integration über weißes Rauschen), damit es nach
// Leitungsrauschen statt nach kaputtem Kassettenband klingt.
function createNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_BUFFER_SECONDS));
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

// Eine Leitung pro Gesprächspartner: Bandpass, Kompression, Sättigung.
export class PhoneAudio {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private filterNodes: BiquadFilterNode[] = [];
  private compressor: DynamicsCompressorNode | null = null;
  private shaper: WaveShaperNode | null = null;
  private noiseSource: AudioBufferSourceNode | null = null;
  private noiseFilters: BiquadFilterNode[] = [];
  private noiseGain: GainNode | null = null;
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

      // Kaskadierte Hoch-/Tiefpässe: jede Stufe legt 12 dB/Oktave drauf, in
      // Summe ein deutlich engeres, "brick-walled" Telefonband.
      const bandpassStages: BiquadFilterNode[] = [];
      for (let i = 0; i < HIGHPASS_STAGES; i++) {
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = HIGHPASS_HZ;
        hp.Q.value = FILTER_Q;
        bandpassStages.push(hp);
      }
      for (let i = 0; i < LOWPASS_STAGES; i++) {
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = LOWPASS_HZ;
        lp.Q.value = FILTER_Q;
        bandpassStages.push(lp);
      }
      this.filterNodes = bandpassStages;

      // Präsenz-Peak: gibt der Stimme den nasalen Hörer-Charakter.
      const presence = ctx.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = PRESENCE_HZ;
      presence.gain.value = PRESENCE_GAIN_DB;
      presence.Q.value = PRESENCE_Q;

      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -24;
      this.compressor.ratio.value = 6;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.15;

      this.shaper = ctx.createWaveShaper();
      this.shaper.curve = saturationCurve(SATURATION_AMOUNT) as any;
      this.shaper.oversample = "2x";

      this.gain = ctx.createGain();
      this.gain.gain.value = this.volume;

      // Stimme: Quelle -> Bandpass-Kaskade -> Präsenz -> Kompressor -> Sättigung -> Gain -> Ausgang.
      let node: AudioNode = this.source;
      for (const stage of bandpassStages) {
        node.connect(stage);
        node = stage;
      }
      node
        .connect(presence)
        .connect(this.compressor)
        .connect(this.shaper)
        .connect(this.gain)
        .connect(ctx.destination);

      // Leitungsrauschen: eigene, gleich gefilterte Kette, leise vor dem
      // gemeinsamen Gain-Knoten zugemischt, damit Lautstärke beides gemeinsam regelt.
      const noise = ctx.createBufferSource();
      noise.buffer = createNoiseBuffer(ctx);
      noise.loop = true;

      const noiseHighpass = ctx.createBiquadFilter();
      noiseHighpass.type = "highpass";
      noiseHighpass.frequency.value = HIGHPASS_HZ;
      noiseHighpass.Q.value = FILTER_Q;

      const noiseLowpass = ctx.createBiquadFilter();
      noiseLowpass.type = "lowpass";
      noiseLowpass.frequency.value = LOWPASS_HZ;
      noiseLowpass.Q.value = FILTER_Q;

      this.noiseFilters = [noiseHighpass, noiseLowpass];

      this.noiseGain = ctx.createGain();
      this.noiseGain.gain.value = NOISE_LEVEL;

      noise
        .connect(noiseHighpass)
        .connect(noiseLowpass)
        .connect(this.noiseGain)
        .connect(this.gain);

      noise.start();
      this.noiseSource = noise;
      console.log("[phone] line noise started");
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
      if (this.noiseSource) {
        try {
          this.noiseSource.stop();
        } catch {
          // Kann bereits gestoppt/nie gestartet sein.
        }
        this.noiseSource.disconnect();
        console.log("[phone] line noise stopped");
      }
      this.noiseFilters.forEach((f) => f.disconnect());
      this.noiseGain?.disconnect();
      this.source?.disconnect();
      this.filterNodes.forEach((f) => f.disconnect());
      this.compressor?.disconnect();
      this.shaper?.disconnect();
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
    this.filterNodes = [];
    this.compressor = null;
    this.shaper = null;
    this.noiseSource = null;
    this.noiseFilters = [];
    this.noiseGain = null;
    this.gain = null;
    this.ctx = null;
  }
}
