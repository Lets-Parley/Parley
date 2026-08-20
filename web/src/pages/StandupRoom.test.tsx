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

  it("warns inside the last quarter without wearing brass", () => {
    // Brass means the facilitator and nothing else (DESIGN.md, the One Brass
    // Rule). A turn running short is urgency, not authority, so the warning
    // escalates by weight and ink rather than borrowing the facilitator's hue.
    render(
      <Timer startedAt={START} seconds={90} serverTime="2026-08-18T10:01:10.000Z" />,
    );
    const el = readClock();
    expect(el.textContent).toBe("0:20");
    expect(el.className).not.toContain("brass");
    expect(el.className).not.toContain("text-stop");
    expect(el.className).toContain("text-ink");
    expect(el.className).toContain("font-bold");
  });

  it("reads at the scale a projected room needs", () => {
    // It shipped at text-3xl in the corner of the header, after an Export CSV
    // link. This is the one number six people read from across a room.
    render(<Timer startedAt={START} seconds={90} serverTime={START} />);
    expect(readClock().className).toContain("var(--text-num-result)");
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
    expect(announcer().textContent).toBe("Dana Whitfield is speaking now, 1 of 3.");
    rerender(
      <StandupRoom
        env={envelope({ state: standupState("marcus") })}
        me={me}
      />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(announcer().textContent).toBe("Marcus Okonjo is speaking now, 2 of 3.");
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

  it("drops the underline clear of the strike-through on a skipped seat", () => {
    // Underline and line-through land on the same seat when a skipped person is
    // being read. At offset-4 the two merge into one thick bar, so the deeper
    // offset is what keeps them readable as two separate facts.
    renderApp(<StandupRoom env={envelope({ state: filledState("dana") })} me={me} />);
    const nameOf = (n: string) => seatButton(n).querySelector("span.underline")!.className;
    expect(nameOf("Dana Whitfield")).toContain("underline-offset-4");
    act(() => seatButton("Priya Raman").click());
    expect(nameOf("Priya Raman")).toContain("line-through");
    expect(nameOf("Priya Raman")).toContain("underline-offset-8");
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
  // A test that fakes timers and then fails would otherwise leave them faked
  // for every test after it, so the reset is unconditional.
  afterEach(() => vi.useRealTimers());

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

  it("waits for the final save to land before issuing the DELETE", async () => {
    // The PUT is held open, so ordering is observable rather than incidental:
    // dropping the await on flush() lets the DELETE go out while the save is
    // still in flight, which this asserts against directly.
    let releasePut: () => void = () => {};
    const held = new Promise<void>((r) => {
      releasePut = r;
    });
    const ok = { status: 204, ok: true, text: async () => "" } as Response;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT") {
        await held;
      }
      return ok;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "held open" } });
    const ended = act(async () => {
      endButton()!.click();
    });
    await act(async () => {});
    const deletes = () =>
      fetchSpy.mock.calls.filter(([u, i]) => u === "/api/sessions/sess-1" && (i as RequestInit)?.method === "DELETE");
    // Recorded, not asserted, until the act() scope is closed: throwing while
    // the held promise is outstanding would leave act entered for every later test.
    const whileHeld = deletes().length;

    releasePut();
    await ended;
    expect(whileHeld).toBe(0);
    expect(deletes()).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("keeps the session open when the final save fails", async () => {
    // Ending is irreversible from the facilitator's side and retrying is not,
    // so a failed last save must stop the DELETE rather than close over it.
    // "Could not save" and "Session closed" must never both be true.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT") {
        throw new Error("network down");
      }
      return { status: 204, ok: true, text: async () => "" } as Response;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "never made it" } });
    await act(async () => {
      endButton()!.click();
    });

    expect(
      fetchSpy.mock.calls.filter(([u, i]) => u === "/api/sessions/sess-1" && (i as RequestInit)?.method === "DELETE"),
    ).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toMatch(/still open/i);
    expect(screen.queryByText(/session closed/i)).toBeNull();
    fetchSpy.mockRestore();
  });

  it("offers End again after a failed save, so the retry it promises is reachable", async () => {
    // The failure message tells the facilitator to try again. If the in-flight
    // guard stayed set on that path, the button would be disabled forever and
    // the advice would be a lie.
    let failNext = true;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT" && failNext) {
        throw new Error("network down");
      }
      return { status: 204, ok: true, text: async () => "" } as Response;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "first go" } });
    await act(async () => {
      endButton()!.click();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/still open/i);
    expect(endButton()).toBeTruthy();
    expect((endButton() as HTMLButtonElement).disabled).toBe(false);

    failNext = false;
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "second go" } });
    await act(async () => {
      endButton()!.click();
    });
    expect(
      fetchSpy.mock.calls.filter(([u, i]) => u === "/api/sessions/sess-1" && (i as RequestInit)?.method === "DELETE"),
    ).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("issues one DELETE however fast End is clicked twice", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT") {
        await held;
      }
      return { status: 204, ok: true, text: async () => "" } as Response;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "one save" } });
    // Both clicks land while the flush is still held.
    endButton()!.click();
    endButton()!.click();
    await act(async () => {
      release();
      await held;
    });

    expect(
      fetchSpy.mock.calls.filter(([u, i]) => u === "/api/sessions/sess-1" && (i as RequestInit)?.method === "DELETE"),
    ).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("flushes a save that is already in flight, not just a pending debounce", async () => {
    // send() clears the pending draft before it awaits, so a request already on
    // the wire is invisible to pending.current. Without the chain, End would
    // fire the DELETE past an unfinished PUT and lose that write.
    vi.useFakeTimers();
    let releaseFirst: () => void = () => {};
    const held = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let puts = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT") {
        puts += 1;
        if (puts === 1) await held;
      }
      return { status: 204, ok: true, text: async () => "" } as Response;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "in flight" } });
    // Let the debounce fire, so the PUT is out and nothing is left pending.
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    const putsBeforeEnd = puts;

    const ended = act(async () => {
      endButton()!.click();
    });
    await act(async () => {});
    const deletes = () =>
      fetchSpy.mock.calls.filter(([u, i]) => u === "/api/sessions/sess-1" && (i as RequestInit)?.method === "DELETE");
    const whileHeld = deletes().length;

    releaseFirst();
    await ended;
    expect(putsBeforeEnd).toBe(1);
    expect(whileHeld).toBe(0);
    expect(deletes()).toHaveLength(1);
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

describe("StandupRoom round composition", () => {
  it("puts the round's position on screen, big, and says it once", () => {
    // "How long do I have" and "am I next" are the two questions a standup
    // asks. The second was answerable only by counting wrapped chips.
    renderApp(<StandupRoom env={envelope()} me={me} />);
    const progress = screen.getByTestId("round-progress");
    expect(progress.textContent).toBe("1 / 3speaking");
    expect(progress.className).toContain("tabular-nums");
    // The live region is the single voice for this, as on the poker field.
    expect(progress.getAttribute("aria-hidden")).toBe("true");
    expect(announcer().textContent).toMatch(/1 of 3/);
  });

  it("names who is up next, skipping a seat that was marked absent", () => {
    renderApp(<StandupRoom env={envelope()} me={me} />);
    expect(screen.getByTestId("next-speaker").textContent).toBe("Next: Marcus Okonjo");
  });

  it("says it is the last turn rather than naming nobody", () => {
    // Marcus is second of three and Priya is skipped, so nobody follows him.
    const env = envelope({ state: standupState("marcus") });
    renderApp(<StandupRoom env={env} me={me} />);
    expect(screen.getByTestId("next-speaker").textContent).toBe("Last turn");
  });

  it("keeps the facilitator's Next where their hand left it", () => {
    // Next and Skip sat at the bottom of a card whose height varies with how
    // much the speaker typed, so the button moved between speakers.
    const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };
    renderApp(<StandupRoom env={envelope()} me={dana} />);
    const bar = screen.getByTestId("facilitator-bar");
    expect(bar.className).toContain("sticky");
    expect(bar.contains(screen.getByRole("button", { name: "Next" }))).toBe(true);
  });

  it("does not spend a whole panel on two tertiary links", () => {
    // The title moved to the shell header in #225 and the countdown moved to
    // the round bar, so the chrome panel was left bordered, padded and empty
    // but for Export CSV and End session.
    const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };
    renderApp(<StandupRoom env={envelope()} me={dana} />);
    const group = screen.getByTestId("session-actions");
    expect(group.contains(screen.getByRole("link", { name: "Export CSV" }))).toBe(true);
    expect(group.contains(screen.getByRole("button", { name: "End session" }))).toBe(true);
    const chrome = group.closest("header")!;
    expect(chrome.className).not.toContain("bg-surface");
    expect(chrome.className).not.toContain("shadow-rest");
    expect(chrome.className).not.toContain("border-line");
  });

  it("houses the speaking order inside the round bar, not between panels", () => {
    // The rail is the round. Left loose between the chrome and the speaker
    // card it read as an orphan strip with no housing.
    renderApp(<StandupRoom env={envelope()} me={me} />);
    const bar = screen.getByTestId("round-bar");
    expect(bar.contains(screen.getByTestId("round-progress"))).toBe(true);
    expect(bar.contains(seat("Dana Whitfield"))).toBe(true);
  });

  it("does not put the round bar on the gathering screen", () => {
    renderApp(<StandupRoom env={envelope({ phase: "gathering" })} me={me} />);
    expect(screen.queryByTestId("round-progress")).toBeNull();
  });
});
