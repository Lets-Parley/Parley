import { afterEach, describe, expect, it, vi } from "vitest";
import { HIT_LEAD_MS, NotificationAudio, soundFor } from "./notificationAudio";

function fakeAudio(state: AudioContextState = "running") {
  const oscillators: Array<{ frequency: { setValueAtTime: ReturnType<typeof vi.fn> }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  // Every scheduled source — oscillators and noise buffers alike — so a hit
  // can be found by its start time whatever it is made of.
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  });
  const gains: Array<{ gain: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn> } }> = [];
  const context = {
    state,
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => { context.state = "running"; }),
    createOscillator: vi.fn(() => {
      const oscillator = {
        type: "sine",
        frequency: param(),
        connect: vi.fn(), start: vi.fn(), stop: vi.fn(),
      };
      oscillators.push(oscillator);
      sources.push(oscillator);
      return oscillator;
    }),
    createGain: vi.fn(() => {
      const gain = {
        gain: param(),
        connect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
    sampleRate: 1000,
    createBuffer: vi.fn((_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }),
    createBufferSource: vi.fn(() => {
      const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      sources.push(source);
      return source;
    }),
    createBiquadFilter: vi.fn(() => ({ type: "lowpass", frequency: param(), connect: vi.fn() })),
  };
  vi.stubGlobal("AudioContext", vi.fn(function AudioContextMock() { return context; }));
  return { context, oscillators, gains, sources };
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

describe("impact sounds", () => {
  const starts = (sources: Array<{ start: ReturnType<typeof vi.fn> }>) =>
    sources.map((s) => s.start.mock.calls[0][0] as number);

  it("tailors the sound to what was thrown", () => {
    expect(soundFor("🍅")).toBe("splat");
    expect(soundFor("🥚")).toBe("splat");
    expect(soundFor("🍞")).toBe("thud");
    expect(soundFor("🥾")).toBe("thud");
    expect(soundFor("😤")).toBe("pop");
    expect(soundFor("🚩")).toBe("pop");
  });

  it("schedules one hit per throw on the audio clock, at contact", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { sources } = fakeAudio();
    const audio = new NotificationAudio();
    audio.enabled = true;
    audio.hits([{ emoji: "🍅", atMs: 400 }, { emoji: "🍞", atMs: 650 }, { emoji: "😤", atMs: 900 }]);
    await vi.waitFor(() => expect(sources).toHaveLength(3));
    const at = starts(sources);
    [10.4, 10.65, 10.9].forEach((t, i) => expect(at[i]).toBeCloseTo(t - HIT_LEAD_MS / 1000));
    vi.restoreAllMocks();
  });

  it("schedules early by the output latency, so the hit is heard at contact", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { context, sources } = fakeAudio();
    Object.assign(context, { outputLatency: 0.03, baseLatency: 0.01 });
    const audio = new NotificationAudio();
    audio.enabled = true;
    audio.hits([{ emoji: "😤", atMs: 400 }]);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(starts(sources)[0]).toBeCloseTo(10.37 - HIT_LEAD_MS / 1000);
    vi.restoreAllMocks();
  });

  it("anchors to the animation's own start, mapped onto the output clock", async () => {
    vi.spyOn(performance, "now").mockReturnValue(850);
    const { context, sources } = fakeAudio();
    // 9.9s of context audio was leaving the speaker at page time 900ms.
    Object.assign(context, {
      getOutputTimestamp: () => ({ contextTime: 9.9, performanceTime: 900 }),
    });
    const audio = new NotificationAudio();
    audio.enabled = true;
    // The animation started at 1000ms, a frame after the call; contact 400ms in.
    audio.hits([{ emoji: "😤", atMs: 400 }], Promise.resolve(1000));
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(starts(sources)[0]).toBeCloseTo(10.4 - HIT_LEAD_MS / 1000);
    vi.restoreAllMocks();
  });

  it("gives the squash and the thump more gain than the pop, to be heard over it", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { gains, sources } = fakeAudio();
    const audio = new NotificationAudio();
    audio.enabled = true;
    audio.hits([{ emoji: "😤", atMs: 100 }, { emoji: "🍅", atMs: 100 }, { emoji: "🍞", atMs: 100 }]);
    await vi.waitFor(() => expect(sources).toHaveLength(3));
    const peak = gains.map((g) => g.gain.linearRampToValueAtTime.mock.calls[0][0] as number);
    expect(peak[1]).toBeGreaterThan(peak[0] * 2);
    expect(peak[2]).toBeGreaterThan(peak[0] * 2);
    vi.restoreAllMocks();
  });

  it("counts the time spent waking the context, and drops hits already past", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const { context, sources } = fakeAudio("suspended");
    context.resume.mockImplementation(async () => {
      now.mockReturnValue(300);
      context.state = "running";
    });
    const audio = new NotificationAudio();
    audio.enabled = true;
    audio.hits([{ emoji: "🍅", atMs: 200 }, { emoji: "🍅", atMs: 500 }]);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(starts(sources)[0]).toBeCloseTo(10.2 - HIT_LEAD_MS / 1000);
    vi.restoreAllMocks();
  });

  it("stays silent when sounds are off or the tab is hidden", async () => {
    const { context } = fakeAudio();
    const audio = new NotificationAudio();
    audio.hits([{ emoji: "🍅", atMs: 100 }]);
    audio.enabled = true;
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    audio.hits([{ emoji: "🍅", atMs: 100 }]);
    await Promise.resolve();
    expect(globalThis.AudioContext).not.toHaveBeenCalled();
    expect(context.createBufferSource).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("is cancelled by its own cleanup and by stop, but not by a cue", async () => {
    const { sources } = fakeAudio();
    const audio = new NotificationAudio();
    audio.enabled = true;
    const cancel = audio.hits([{ emoji: "🍅", atMs: 100 }]);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    const hit = sources[0];
    await audio.play("poker-reveal");
    expect(hit.stop).toHaveBeenCalledTimes(1); // only its own scheduled end
    cancel();
    expect(hit.stop).toHaveBeenCalledTimes(2);

    audio.hits([{ emoji: "🍞", atMs: 100 }]);
    await vi.waitFor(() => expect(sources).toHaveLength(4));
    const second = sources[3];
    audio.stop();
    expect(second.stop).toHaveBeenCalledTimes(2);
  });

  it("schedules nothing when stopped while the context wakes", async () => {
    const { context, sources } = fakeAudio("suspended");
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
    audio.enabled = true;
    audio.hits([{ emoji: "🍅", atMs: 500 }]);
    audio.stop();
    resume();
    await new Promise((r) => setTimeout(r, 0));
    expect(sources).toHaveLength(0);
  });
});
