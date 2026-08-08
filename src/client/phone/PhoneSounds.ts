import { Howl } from "howler";
import { assetUrl } from "../../core/AssetUrls";

type LoopName = "ring" | "dial-tone" | "busy-tone";
type OneShotName = "dial-click" | "pick-up" | "hang-up";

// The three loop tracks (ring, dial-tone, busy-tone) must be seamless loops:
// cut at a zero-crossing, exactly one period of the ring/tone cycle, so
// Howler's `loop: true` can repeat them with no audible click or gap.
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

// As in SoundManager: slider positions are linear, but perceived loudness
// isn't, so we square the position for an audio-taper curve. PhoneSounds
// keeps its own copy rather than importing SoundManager's private helper —
// this volume is deliberately independent of the sound-effects slider,
// because a ring you can't turn down is intolerable.
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
    for (const howl of this.loops.values())
      this.safely("set loop volume", () => howl.volume(this.volume));
    for (const howl of this.oneShots.values())
      this.safely("set one-shot volume", () => howl.volume(this.volume));
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

  // Only one loop plays at a time: starting a loop stops the current one.
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
