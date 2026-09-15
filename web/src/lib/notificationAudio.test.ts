import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationAudio } from "./notificationAudio";

function fakeAudio(state: AudioContextState = "running") {
  const oscillators: Array<{ frequency: { setValueAtTime: ReturnType<typeof vi.fn> }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const gains: Array<{ gain: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn> } }> = [];
  const context = {
    state,
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => { context.state = "running"; }),
    createOscillator: vi.fn(() => {
      const oscillator = {
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      };
      oscillators.push(oscillator);
      return oscillator;
    }),
    createGain: vi.fn(() => {
      const gain = {
        gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
        connect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
  };
  vi.stubGlobal("AudioContext", vi.fn(function AudioContextMock() { return context; }));
  return { context, oscillators, gains };
}

afterEach(() => vi.unstubAllGlobals());

describe("NotificationAudio", () => {
  it("creates one context lazily and schedules the requested cue at low gain", async () => {
    const { context, oscillators, gains } = fakeAudio();
    const audio = new NotificationAudio();
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(await audio.play("poker-start")).toBe(true);
    expect(oscillators).toHaveLength(2);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(523, 10);
    expect(oscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(659, 10.16);
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.06, 10.008);
    expect(globalThis.AudioContext).toHaveBeenCalledOnce();
    await audio.play("poker-reveal");
    expect(globalThis.AudioContext).toHaveBeenCalledOnce();
  });

  it("uses the three pulse and long-finish timing patterns", async () => {
    const { oscillators } = fakeAudio();
    const audio = new NotificationAudio();
    await audio.play("standup-turn");
    [10.07, 10.22, 10.37].forEach((end, i) =>
      expect(oscillators[i].stop.mock.calls[0][0]).toBeCloseTo(end),
    );
    await audio.play("standup-finish");
    [10.12, 10.28, 10.56].forEach((end, i) =>
      expect(oscillators.at(i - 3)?.stop.mock.calls[0][0]).toBeCloseTo(end),
    );
  });

  it("replaces unfinished audio and can cancel it immediately", async () => {
    const { oscillators } = fakeAudio();
    const audio = new NotificationAudio();
    await audio.play("standup-start");
    await audio.play("poker-reveal");
    expect(oscillators.slice(0, 3).every((o) => o.stop.mock.calls.length === 2)).toBe(true);
    audio.stop();
    expect(oscillators.slice(-2).every((o) => o.stop.mock.calls.length === 2)).toBe(true);
  });

  it("resumes from an interaction and reports blocked or unavailable audio", async () => {
    const { context } = fakeAudio("suspended");
    const audio = new NotificationAudio();
    expect(await audio.activate()).toBe(true);
    expect(context.resume).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
    expect(await new NotificationAudio().activate()).toBe(false);
  });

  it("reports blocked when resume never settles without a gesture", async () => {
    vi.useFakeTimers();
    const { context, oscillators } = fakeAudio("suspended");
    context.resume.mockImplementation(() => new Promise<void>(() => {}));
    const playing = new NotificationAudio().play("poker-start");
    await vi.advanceTimersByTimeAsync(250);
    expect(await playing).toBe(false);
    expect(oscillators).toHaveLength(0);
    vi.useRealTimers();
  });

  it("does not schedule a cue after it is stopped during activation", async () => {
    const { context, oscillators } = fakeAudio("suspended");
    let resume!: () => void;
    context.resume.mockImplementation(
      () => new Promise<void>((resolve) => {
        resume = () => {
          context.state = "running";
          resolve();
        };
      }),
    );
    const audio = new NotificationAudio();
    const playing = audio.play("poker-start");
    audio.stop();
    resume();
    expect(await playing).toBe(false);
    expect(oscillators).toHaveLength(0);
  });
});
