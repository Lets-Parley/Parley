import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StandupRoom, Timer } from "./StandupRoom";
import { makePerson, renderApp } from "../test/render";
import type { Envelope, Me } from "../lib/api";
import type { StandupEntry } from "./StandupRoom";

const START = "2026-08-18T10:00:00.000Z";

function readClock() {
  return screen.getByText(/^\d+:\d{2}$/);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("StandupRoom Timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down between WebSocket frames instead of freezing", async () => {
    // The shipped bug recomputed the server offset on every render, so the two
    // Date.now() calls cancelled and the countdown showed the same number until
    // the next frame landed. Nothing here changes serverTime — only wall clock
    // moves — so a frozen clock fails this test.
    render(<Timer startedAt={START} seconds={90} serverTime={START} />);
    expect(readClock().textContent).toBe("1:30");

    await advance(12_000);
    expect(readClock().textContent).toBe("1:18");

    await advance(12_000);
    expect(readClock().textContent).toBe("1:06");
  });

  it("re-syncs to the server clock when a new frame arrives", async () => {
    const { rerender } = render(<Timer startedAt={START} seconds={90} serverTime={START} />);
    await advance(10_000);
    expect(readClock().textContent).toBe("1:20");

    // The server says 40s have elapsed while our wall clock saw 10 — the frame
    // wins, because every screen in the room must show the same number.
    rerender(
      <Timer startedAt={START} seconds={90} serverTime="2026-08-18T10:00:40.000Z" />,
    );
    // The offset is refreshed in an effect, so the corrected number appears on
    // the next tick rather than in the same commit.
    await advance(500);
    expect(readClock().textContent).toBe("0:50");
  });

  it("clamps the display at 0:00 but keeps the overrun tone", async () => {
    render(
      <Timer startedAt={START} seconds={90} serverTime="2026-08-18T10:01:40.000Z" />,
    );
    const el = readClock();
    // Display is clamped, tone is not — an overrun must still read as stopped
    // rather than quietly parking at a calm 0:00.
    expect(el.textContent).toBe("0:00");
    expect(el.className).toContain("text-stop");
  });

  it("warns in brass inside the last quarter", () => {
    render(
      <Timer startedAt={START} seconds={90} serverTime="2026-08-18T10:01:10.000Z" />,
    );
    const el = readClock();
    expect(el.textContent).toBe("0:20");
    expect(el.className).toContain("text-brass");
    expect(el.className).not.toContain("text-stop");
  });

  it("is calm for the bulk of the turn", () => {
    render(<Timer startedAt={START} seconds={90} serverTime={START} />);
    expect(readClock().className).toContain("text-ink-soft");
  });

  it("formats minutes and seconds, zero-padding the seconds", () => {
    render(
      <Timer startedAt={START} seconds={125} serverTime="2026-08-18T10:00:02.000Z" />,
    );
    expect(readClock().textContent).toBe("2:03");
  });

  it("stops its interval on unmount", async () => {
    const { unmount } = render(<Timer startedAt={START} seconds={90} serverTime={START} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

const me: Me = { id: "marcus", name: "Marcus Okonjo", avatarHue: 40 };

function entry(over: Partial<StandupEntry> = {}): StandupEntry {
  return { userId: "dana", yesterday: "", today: "", blockers: "", position: 1, skipped: false, ready: false, ...over };
}

function standupState(currentSpeakerId: string | null = "dana"): Envelope["state"] {
  return {
    entries: [
      entry({ userId: "dana", position: 1 }),
      entry({ userId: "marcus", position: 2 }),
      entry({ userId: "priya", position: 3, skipped: true }),
    ],
    currentSpeakerId,
    speakerStartedAt: START,
    secondsPerPerson: 90,
  } as unknown as Envelope["state"];
}

/** Dana speaks first, Marcus second, Priya was skipped. */
function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: "sess-1",
    kind: "standup",
    title: "Daily",
    phase: "speaking",
    revealed: false,
    version: 1,
    facilitatorId: "dana",
    facilitatorConnected: true,
    endedAt: null,
    presence: ["marcus"],
    spaceSlug: "platform-team",
    participants: [
      makePerson({ userId: "dana", name: "Dana Whitfield" }),
      makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
      makePerson({ userId: "priya", name: "Priya Raman" }),
    ],
    serverTime: "2026-08-18T10:00:00.000Z",
    state: standupState(),
    ...over,
  };
}

const announcer = () => screen.getByRole("status");
const seat = (name: string) =>
  screen.getAllByRole("listitem").find((li) => li.textContent?.includes(name))!;

describe("StandupRoom turn accessibility", () => {
  it("marks the current speaker with aria-current and a text equivalent", () => {
    renderApp(<StandupRoom env={envelope()} me={me} />);
    const dana = seat("Dana Whitfield");
    expect(dana.getAttribute("aria-current")).toBe("true");
    expect(dana.textContent).toMatch(/speaking now/i);
    expect(seat("Marcus Okonjo").getAttribute("aria-current")).toBe(null);
  });

  it("says skipped in text, not only in opacity and a line-through", () => {
    renderApp(<StandupRoom env={envelope()} me={me} />);
    expect(seat("Priya Raman").textContent).toMatch(/skipped or absent/i);
    expect(seat("Marcus Okonjo").textContent).not.toMatch(/skipped/i);
  });

  it("de-emphasises a skipped seat without dimming its text below AA", () => {
    renderApp(<StandupRoom env={envelope()} me={me} />);
    const priya = seat("Priya Raman");
    // A group opacity wrapper multiplies through the name and drops it to
    // 2.38:1 on the felt. The dimming lives on the avatar instead.
    expect(priya.className).not.toMatch(/\bopacity-/);
    const name = screen.getByText("Priya Raman");
    expect(name.className).toMatch(/text-ink-faint/);
    expect(name.className).toMatch(/line-through/);
    expect(screen.getByText("Marcus Okonjo").className).not.toMatch(/text-ink-faint/);
  });

  it("keeps the countdown out of the announcement and out of the a11y tree", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    try {
      renderApp(<StandupRoom env={envelope()} me={me} />);
      const before = announcer().textContent;
      expect(before).not.toMatch(/\d+:\d{2}/);
      expect(screen.getByText(/^\d+:\d{2}$/).closest("[aria-hidden='true']")).not.toBe(null);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(announcer().textContent).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces a turn change exactly once, naming only the new speaker", () => {
    const { rerender } = renderApp(<StandupRoom env={envelope()} me={me} />);
    expect(announcer().textContent).toBe("Dana Whitfield is speaking now.");
    rerender(
      <StandupRoom
        env={envelope({ state: standupState("marcus") })}
        me={me}
      />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(announcer().textContent).toBe("Marcus Okonjo is speaking now.");
  });

  it("announces the end of the session", () => {
    renderApp(
      <StandupRoom env={envelope({ phase: "done", state: standupState(null) })} me={me} />,
    );
    expect(announcer().textContent).toMatch(/wrapped up|complete|over/i);
  });

  it("stays silent while the connection is not live, so it doesn't queue behind the banner", () => {
    renderApp(<StandupRoom env={envelope()} me={me} status="stale" />);
    expect(announcer().textContent).toBe("");
  });
});

/** A standup still gathering: nobody is speaking and the entry form is open. */
function gathering(over: Partial<Envelope> = {}, entries?: Partial<StandupEntry>[]): Envelope {
  const rows = entries ?? [
    { userId: "dana", position: 1 },
    { userId: "marcus", position: 2 },
    { userId: "priya", position: 3 },
  ];
  return envelope({
    phase: "",
    state: {
      entries: rows.map((r) => entry(r)),
      currentSpeakerId: null,
      speakerStartedAt: null,
      secondsPerPerson: 90,
    } as unknown as Envelope["state"],
    ...over,
  });
}

const startButton = () => screen.getByRole("button", { name: /start the round/i });

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 204 }),
  );
}

describe("StandupRoom readiness", () => {
  afterEach(() => vi.restoreAllMocks());

  it("round-trips the ready toggle through the ready action", async () => {
    const f = mockFetch();
    renderApp(<StandupRoom env={gathering()} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: /i'm ready/i }));
    expect(f).toHaveBeenCalledTimes(1);
    const [path, init] = f.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/sessions/sess-1/actions/ready");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ ready: true });
  });

  it("sends ready:false to stand back down rather than a blind toggle", async () => {
    const f = mockFetch();
    renderApp(
      <StandupRoom
        env={gathering({}, [
          { userId: "dana", position: 1 },
          { userId: "marcus", position: 2, ready: true },
          { userId: "priya", position: 3 },
        ])}
        me={me}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /ready/i }));
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ ready: false });
  });

  it("says who is ready in text, not colour alone", () => {
    renderApp(
      <StandupRoom
        env={gathering({}, [
          { userId: "dana", position: 1, ready: true },
          { userId: "marcus", position: 2 },
          { userId: "priya", position: 3 },
        ])}
        me={me}
      />,
    );
    const who = screen.getByTestId("ready-roster");
    expect(who.textContent).toMatch(/Dana Whitfield/);
    expect(who.textContent).toMatch(/ready/i);
    expect(who.textContent).toMatch(/Marcus Okonjo|Priya Raman/);
  });

  it("counts the ready signals in the facilitator's button", () => {
    renderApp(
      <StandupRoom
        env={gathering({ facilitatorId: "marcus" }, [
          { userId: "dana", position: 1, ready: true },
          { userId: "marcus", position: 2, ready: true },
          { userId: "priya", position: 3 },
        ])}
        me={me}
      />,
    );
    expect(startButton().textContent).toMatch(/2 of 3 ready/);
  });

  it("still fires the start request with nobody ready — advisory, never a gate", async () => {
    // Asserted on the REQUEST rather than toBeEnabled(): a button gated by
    // aria-disabled, hidden, or an early return in onClick passes that check
    // and still refuses to start the round.
    const f = mockFetch();
    renderApp(<StandupRoom env={gathering({ facilitatorId: "marcus" })} me={me} />);
    expect(startButton().textContent).toMatch(/0 of 3 ready/);
    await userEvent.click(startButton());
    const call = f.mock.calls.find(([p]) => String(p).endsWith("/actions/start"));
    expect(call).toBeDefined();
    expect((call![1] as RequestInit).method).toBe("POST");
  });

  it("keeps readiness out of the round once it has started", () => {
    renderApp(<StandupRoom env={envelope()} me={me} />);
    expect(screen.queryByRole("button", { name: /i'm ready/i })).toBe(null);
    expect(screen.queryByTestId("ready-roster")).toBe(null);
  });
});
