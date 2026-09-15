import type { NotificationCue } from "./notifications";

const patterns: Record<NotificationCue, Array<[number, number, number]>> = {
  "poker-start": [[523, 0, 0.12], [659, 0.16, 0.12]],
  "poker-reveal": [[784, 0, 0.12], [1047, 0.16, 0.12]],
  "standup-start": [[392, 0, 0.12], [523, 0.16, 0.12], [659, 0.32, 0.12]],
  "standup-turn": [[880, 0, 0.07], [880, 0.15, 0.07], [880, 0.3, 0.07]],
  "standup-finish": [[659, 0, 0.12], [523, 0.16, 0.12], [392, 0.32, 0.24]],
};

export class NotificationAudio {
  private context?: AudioContext;
  private playing: OscillatorNode[] = [];
  private request = 0;

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
    this.stop();
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

  stop() {
    this.request++;
    const now = this.context?.currentTime ?? 0;
    for (const oscillator of this.playing) {
      try {
        oscillator.stop(now);
      } catch {
        // It already ended.
      }
    }
    this.playing = [];
  }
}

export const notificationAudio = new NotificationAudio();
