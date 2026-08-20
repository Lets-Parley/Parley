import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

/** Everyone has written something, so a re-read has something to show. */
function filledState(currentSpeakerId: string | null = "dana"): Envelope["state"] {
  return {
    entries: [
      entry({ userId: "dana", position: 1, yesterday: "dana yesterday", today: "dana today", blockers: "dana blocked" }),
      entry({ userId: "marcus", position: 2, yesterday: "my yesterday", today: "my today", blockers: "" }),
      entry({ userId: "priya", position: 3, skipped: true, yesterday: "priya yesterday", today: "priya today", blockers: "" }),
    ],
    currentSpeakerId,
    speakerStartedAt: START,
    secondsPerPerson: 90,
  } as unknown as Envelope["state"];
}

const seatButton = (name: string) => screen.getByRole("button", { name });

describe("StandupRoom re-reading entries", () => {
  it("shows whoever you pick in the rail, not only the current speaker", () => {
    renderApp(<StandupRoom env={envelope({ state: filledState("dana") })} me={me} />);
    expect(screen.getByText("dana yesterday")).toBeTruthy();

    act(() => seatButton("Priya Raman").click());
    expect(screen.getByText("priya yesterday")).toBeTruthy();
    expect(screen.getByText("priya today")).toBeTruthy();
    expect(screen.queryByText("dana yesterday")).toBeNull();
  });

  it("keeps a chosen entry while the turn moves on underneath", () => {
    const { rerender } = renderApp(
      <StandupRoom env={envelope({ state: filledState("dana") })} me={me} />,
    );
    act(() => seatButton("Priya Raman").click());
    rerender(<StandupRoom env={envelope({ state: filledState("marcus") })} me={me} />);
    expect(screen.getByText("priya yesterday")).toBeTruthy();
  });

  it("keeps every entry reachable after the standup is done", () => {
    renderApp(
      <StandupRoom env={envelope({ phase: "done", state: filledState(null) })} me={me} />,
    );
    act(() => seatButton("Dana Whitfield").click());
    expect(screen.getByText("dana yesterday")).toBeTruthy();
    expect(screen.getByText("dana blocked")).toBeTruthy();
  });

  it("opens a skipped person's entry too, and still says they were skipped", () => {
    renderApp(<StandupRoom env={envelope({ state: filledState("dana") })} me={me} />);
    act(() => seatButton("Priya Raman").click());
    expect(screen.getByText("priya today")).toBeTruthy();
    expect(seat("Priya Raman").textContent).toMatch(/skipped or absent/i);
  });

  it("marks the picked seat in more than colour, and keeps aria-current on the row", () => {
    renderApp(<StandupRoom env={envelope({ state: filledState("dana") })} me={me} />);
    act(() => seatButton("Priya Raman").click());
    expect(seatButton("Priya Raman").getAttribute("aria-pressed")).toBe("true");
    expect(seatButton("Dana Whitfield").getAttribute("aria-pressed")).toBe("false");
    // The current-speaker pin stays on the <li>, where the a11y tests read it.
    expect(seat("Dana Whitfield").getAttribute("aria-current")).toBe("true");
  });

  it("leaves the edit form bound to the viewer when someone else is picked", () => {
    renderApp(<StandupRoom env={envelope({ state: filledState("marcus") })} me={me} />);
    const mine = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    expect(mine[0].value).toBe("my yesterday");

    act(() => seatButton("Priya Raman").click());
    // Priya's words are read-only prose — never loaded into the viewer's own
    // autosaving draft, which would write them onto the viewer's row.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByText("priya yesterday")).toBeTruthy();

    act(() => seatButton("Marcus Okonjo").click());
    expect((screen.getAllByRole("textbox")[0] as HTMLTextAreaElement).value).toBe("my yesterday");
  });

  it("lets go of a held seat when you click it again, and follows the round once more", () => {
    // The hold is otherwise a one-way door: without this, picking anybody stops
    // the panel following the speaker for the rest of the session.
    const { rerender } = renderApp(
      <StandupRoom env={envelope({ state: filledState("dana") })} me={me} />,
    );
    act(() => seatButton("Priya Raman").click());
    expect(screen.getByText("priya yesterday")).toBeTruthy();

    act(() => seatButton("Priya Raman").click());
    expect(seatButton("Priya Raman").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("dana yesterday")).toBeTruthy();

    // Released means released: the panel tracks the next turn again.
    rerender(<StandupRoom env={envelope({ state: filledState("marcus") })} me={me} />);
    expect(screen.getByText("my yesterday")).toBeTruthy();
  });

  it("keeps your own past entry read-only once the round is done", () => {
    // During `speaking` your own row is the live edit form. After the round
    // ends it must be prose — the form coming back would offer an edit the
    // server has already closed off.
    renderApp(
      <StandupRoom env={envelope({ phase: "done", state: filledState(null) })} me={me} />,
    );
    act(() => seatButton("Marcus Okonjo").click());
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByText("my yesterday")).toBeTruthy();
  });

  it("still shows the entry panel in the done phase", () => {
    renderApp(
      <StandupRoom env={envelope({ phase: "done", state: filledState(null) })} me={me} />,
    );
    act(() => seatButton("Priya Raman").click());
    expect(screen.getByRole("heading", { name: "Priya Raman" })).toBeTruthy();
    expect(screen.getByText("priya yesterday")).toBeTruthy();
  });

  it("does not leak Next and Skip into the done phase", () => {
    // `done` still carries a currentSpeakerId in the wild if the round was
    // ended mid-turn, so the facilitator controls need the phase guard too.
    renderApp(
      <StandupRoom
        env={envelope({ phase: "done", facilitatorId: "marcus", state: filledState("dana") })}
        me={me}
      />,
    );
    expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
  });
});

describe("StandupRoom ending the session", () => {
  const endButton = () => screen.queryByRole("button", { name: /end session/i });

  it("is not offered to anyone but the facilitator", () => {
    renderApp(<StandupRoom env={envelope()} me={me} />);
    expect(endButton()).toBeNull();
  });

  it("is offered to the facilitator", () => {
    renderApp(<StandupRoom env={envelope({ facilitatorId: "marcus" })} me={me} />);
    expect(endButton()).toBeTruthy();
  });

  it("deletes the session", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ status: 204, ok: true, text: async () => "" } as Response);
    renderApp(<StandupRoom env={envelope({ facilitatorId: "marcus" })} me={me} />);
    await act(async () => {
      endButton()!.click();
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sessions/sess-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    fetchSpy.mockRestore();
  });

  it("stops being offered once the session has already ended", () => {
    renderApp(
      <StandupRoom
        env={envelope({ facilitatorId: "marcus", endedAt: "2026-08-18T10:30:00.000Z" })}
        me={me}
      />,
    );
    expect(endButton()).toBeNull();
  });

  it("sends the last keystrokes before closing the session", async () => {
    // Autosave is debounced by 800ms, and the server refuses writes to an ended
    // session. Ending without flushing first throws away whatever the
    // facilitator typed in the final second, as an unretryable "Could not save".
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ status: 204, ok: true, text: async () => "" } as Response);
    renderApp(
      <StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />,
    );

    const yesterday = screen.getAllByRole("textbox")[0];
    fireEvent.change(yesterday, { target: { value: "the very last thing I typed" } });
    // No timer advance: the point is that ending does not wait out the debounce.
    await act(async () => {
      endButton()!.click();
    });

    const calls = fetchSpy.mock.calls;
    const saveAt = calls.findIndex(
      ([url, init]) =>
        url === "/api/sessions/sess-1/actions/standup" &&
        (init as RequestInit).method === "PUT" &&
        String((init as RequestInit).body).includes("the very last thing I typed"),
    );
    const deleteAt = calls.findIndex(
      ([url, init]) => url === "/api/sessions/sess-1" && (init as RequestInit).method === "DELETE",
    );
    expect(saveAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(saveAt).toBeLessThan(deleteAt);
    fetchSpy.mockRestore();
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
