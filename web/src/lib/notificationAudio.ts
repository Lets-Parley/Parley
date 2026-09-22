import type { NotificationCue } from "./notifications";

const patterns: Record<NotificationCue, Array<[number, number, number]>> = {
  "poker-start": [[523, 0, 0.12], [659, 0.16, 0.12]],
  "poker-reveal": [[784, 0, 0.12], [1047, 0.16, 0.12]],
  "standup-start": [[392, 0, 0.12], [523, 0.16, 0.12], [659, 0.32, 0.12]],
  "standup-turn": [[880, 0, 0.07], [880, 0.15, 0.07], [880, 0.3, 0.07]],
  "standup-finish": [[659, 0, 0.12], [523, 0.16, 0.12], [392, 0.32, 0.24]],
};

/** What a thrown emoji sounds like when it lands. Food squashes, bread and the
 *  kick's boot thump, and anything that is not an object — a face, a flag —
 *  just pops. */
export type HitSound = "splat" | "thud" | "pop";
const SPLAT = new Set(["🍅", "🥚", "🥧", "🍌", "🍋"]);
export function soundFor(emoji: string): HitSound {
  return SPLAT.has(emoji) ? "splat" : emoji === "🍞" || emoji === "🥾" ? "thud" : "pop";
}

/** Quieter than a cue, since a pile-on can land thirteen at once. The squash
 *  and the thump are louder than the pop because a lowpassed noise and a low
 *  sine lose most of their energy on small speakers. */
/** Calibration, tuned by ear on Windows Chrome: the device's shared-mode
 *  buffer is not in getOutputTimestamp, so every hit goes this much early. */
export const HIT_LEAD_MS = 15;

const HIT_GAIN: Record<HitSound, number> = { splat: 0.14, thud: 0.12, pop: 0.04 };

export class NotificationAudio {
  /** Set by the session page from the viewer's preference; hits check it,
   *  cues are gated by their caller. */
  enabled = false;
  private context?: AudioContext;
  private playing: OscillatorNode[] = [];
  private hitting: AudioScheduledSourceNode[] = [];
  private request = 0;
  private hitRequest = 0;
  private noise?: AudioBuffer;

  async activate(): Promise<boolean> {
    if (!this.context) {
      const AudioContextClass =
        globalThis.AudioContext ??
        (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextClass) return false;
      this.context = new AudioContextClass();
    }
    try {
      // Without a user gesture resume() stays pending rather than rejecting, so
      // a short wait reports blocked instead of hanging every later cue.
      if (this.context.state !== "running") {
        await Promise.race([
          this.context.resume(),
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
      }
      return this.context.state === "running";
    } catch {
      return false;
    }
  }

  async play(cue: NotificationCue): Promise<boolean> {
    this.stopCue();
    const request = this.request;
    if (!(await this.activate()) || !this.context || request !== this.request) return false;
    const start = this.context.currentTime;
    for (const [frequency, offset, duration] of patterns[cue]) {
      const at = start + offset;
      const end = at + duration;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.06, at + 0.008);
      gain.gain.setValueAtTime(0.06, Math.max(at + 0.008, end - 0.03));
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(this.context.destination);
      oscillator.start(at);
      oscillator.stop(end);
      this.playing.push(oscillator);
    }
    return true;
  }

  /**
   * Impact sounds, each `atMs` after `origin` — the page-clock time the
   * animation actually started, which is a frame or more after this call
   * (measured ~50ms in Chrome). Without one, this call is the origin. Scheduled on the audio clock rather than
   * timers so they land on the frame. The context is usually still waking
   * (the reveal cue starts it in the same commit), so the wait is subtracted
   * and a hit already past is dropped rather than played late.
   */
  hits(list: Array<{ emoji: string; atMs: number }>, origin?: Promise<number>): () => void {
    // A hidden tab throttles the animation but not the audio clock.
    if (!this.enabled || document.hidden || list.length === 0) return () => {};
    const t0 = performance.now();
    const request = this.hitRequest;
    const mine: AudioScheduledSourceNode[] = [];
    let cancelled = false;
    void Promise.all([this.activate(), origin ?? t0]).then(([ready, start]) => {
      const ctx = this.context;
      if (!ready || !ctx || cancelled || request !== this.hitRequest) return;
      // Page time → the context time that will be *leaving the speaker* then.
      // The output timestamp carries the device latency; before the first
      // render quantum it is zero, so fall back to the reported latency.
      const ts = ctx.getOutputTimestamp?.();
      const toContext = ts?.performanceTime
        ? (page: number) => ts.contextTime! + (page - ts.performanceTime!) / 1000
        : (page: number) =>
            ctx.currentTime +
            (page - performance.now()) / 1000 -
            (ctx.outputLatency ?? 0); // already includes baseLatency
      list.forEach(({ emoji, atMs }, i) => {
        const at = toContext(start + atMs - HIT_LEAD_MS);
        if (at < ctx.currentTime) return;
        const node = this.hit(ctx, soundFor(emoji), at, i);
        mine.push(node);
        this.hitting.push(node);
      });
    });
    return () => {
      cancelled = true;
      halt(mine, this.context);
    };
  }

  private hit(ctx: AudioContext, sound: HitSound, at: number, i: number) {
    // A small spread by index, so a volley is a crowd rather than one sample.
    const spread = 1 + ((i % 5) - 2) * 0.04;
    const length = sound === "splat" ? 0.15 : sound === "thud" ? 0.09 : 0.07;
    const end = at + length;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(HIT_GAIN[sound], at + 0.004);
    gain.gain.linearRampToValueAtTime(0, end);
    gain.connect(ctx.destination);
    let source: AudioScheduledSourceNode;
    if (sound === "splat") {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(ctx);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(3500 * spread, at);
      filter.frequency.exponentialRampToValueAtTime(300, end);
      noise.connect(filter);
      filter.connect(gain);
      source = noise;
    } else {
      const osc = ctx.createOscillator();
      // The thump starts high enough for a laptop speaker to carry its attack.
      const [from, to] = sound === "thud" ? [320, 70] : [600, 300];
      osc.type = sound === "thud" ? "sine" : "triangle";
      osc.frequency.setValueAtTime(from * spread, at);
      osc.frequency.exponentialRampToValueAtTime(to * spread, end);
      osc.connect(gain);
      source = osc;
    }
    source.start(at);
    source.stop(end);
    return source;
  }

  private noiseBuffer(ctx: AudioContext) {
    if (!this.noise) {
      this.noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.15), ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  /** Silences everything, pending hits included: sounds off, or leaving. */
  stop() {
    this.stopCue();
    this.hitRequest++;
    halt(this.hitting, this.context);
    this.hitting = [];
  }

  private stopCue() {
    this.request++;
    halt(this.playing, this.context);
    this.playing = [];
  }
}

function halt(nodes: AudioScheduledSourceNode[], context?: AudioContext) {
  const now = context?.currentTime ?? 0;
  for (const node of nodes) {
    try {
      node.stop(now);
    } catch {
      // It already ended.
    }
  }
}

export const notificationAudio = new NotificationAudio();
