import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StandupRoom, Timer } from "./StandupRoom";
import { makePerson, renderApp } from "../test/render";
import type { Envelope, Me } from "../lib/api";
import type { StandupEntry } from "./StandupRoom";
import type { Commitment } from "../components/Commitments";

function roomCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((c) => !String(c[0]).includes("/plugins/panels"));
}

function answering(response: Response) {
  return (input: RequestInfo | URL) => {
    if (String(input).includes("/plugins/panels")) {
      return Promise.resolve(new Response("[]", { status: 200 }));
    }
    return Promise.resolve(response.clone());
  };
}

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
    render(<Timer startedAt={START} seconds={90} serverTime={START} live />);
    expect(readClock().textContent).toBe("1:30");

    await advance(12_000);
    expect(readClock().textContent).toBe("1:18");

    await advance(12_000);
    expect(readClock().textContent).toBe("1:06");
  });

  it("holds the clock and says so while the socket is down", async () => {
    // The biggest element on a projected screen was also the one that kept
    // counting confidently against a frozen server frame. A stale reading is
    // shown as stale rather than blanked — a missing timer misleads as much as
    // a wrong one.
    const { rerender } = render(
      <Timer startedAt={START} seconds={90} serverTime={START} live />,
    );
    await advance(12_000);
    expect(readClock().textContent).toBe("1:18");

    rerender(<Timer startedAt={START} seconds={90} serverTime={START} live={false} />);
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
  });

  it("re-syncs to the server clock when a new frame arrives", async () => {
    const { rerender } = render(<Timer startedAt={START} seconds={90} serverTime={START} live />);
    await advance(10_000);
    expect(readClock().textContent).toBe("1:20");

    // The server says 40s have elapsed while our wall clock saw 10 — the frame
    // wins, because every screen in the room must show the same number.
    rerender(
      <Timer startedAt={START} seconds={90} serverTime="2026-08-18T10:00:40.000Z" live />,
    );
    // The offset is refreshed in an effect, so the corrected number appears on
    // the next tick rather than in the same commit.
    await advance(500);
    expect(readClock().textContent).toBe("0:50");
  });

  it("clamps the display at 0:00 but keeps the overrun tone", async () => {
    render(
      <Timer startedAt={START} seconds={90} serverTime="2026-08-18T10:01:40.000Z" live />,
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
      <Timer startedAt={START} seconds={90} serverTime="2026-08-18T10:01:10.000Z" live />,
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
    render(<Timer startedAt={START} seconds={90} serverTime={START} live />);
    expect(readClock().className).toContain("var(--text-num-result)");
  });

  it("is calm for the bulk of the turn", () => {
    render(<Timer startedAt={START} seconds={90} serverTime={START} live />);
    expect(readClock().className).toContain("text-ink-soft");
  });

  it("formats minutes and seconds, zero-padding the seconds", () => {
    render(
      <Timer startedAt={START} seconds={125} serverTime="2026-08-18T10:00:02.000Z" live />,
    );
    expect(readClock().textContent).toBe("2:03");
  });

  it("stops its interval on unmount", async () => {
    const { unmount } = render(<Timer startedAt={START} seconds={90} serverTime={START} live />);
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
    kudos: [],
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
    orgSlug: "acme",
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

/** Dana ready, Marcus not — so the roster has exactly one name to print. */
function readyState(): Envelope["state"] {
  const st = standupState(null) as unknown as { entries: StandupEntry[] };
  st.entries[0].ready = true;
  return st as unknown as Envelope["state"];
}
function allReadyState(): Envelope["state"] {
  const st = standupState(null) as unknown as { entries: StandupEntry[] };
  for (const e of st.entries) e.ready = true;
  return st as unknown as Envelope["state"];
}
function noSkipState(): Envelope["state"] {
  const st = standupState(null) as unknown as { entries: StandupEntry[] };
  for (const e of st.entries) e.skipped = false;
  return st as unknown as Envelope["state"];
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
    expect(seat("Priya Raman").textContent).toMatch(/turn skipped/i);
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

  it("names a guest speaker with a text tell, matching the plain member's name elsewhere", () => {
    // A guest may redeem under any display name, a member's included, and the
    // seat's visual " · guest" mark has no screen-reader equivalent unless the
    // announcement spells it out too. The existing "announces a turn change"
    // test above already covers a plain member's name staying unmarked.
    renderApp(
      <StandupRoom
        env={envelope({
          participants: [
            makePerson({ userId: "dana", name: "Dana Whitfield", guest: true }),
            makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
            makePerson({ userId: "priya", name: "Priya Raman" }),
          ],
        })}
        me={me}
      />,
    );
    expect(announcer().textContent).toBe("Dana Whitfield (guest) is speaking now, 1 of 3.");
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
    kudos: [],
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
    expect(seat("Priya Raman").textContent).toMatch(/turn skipped/i);
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
    // Scoped to the update itself: the closing beat's kudos field is a textbox
    // on this page too, and that one is meant to be there.
    for (const field of ["yesterday", "today", "blockers"]) {
      expect(screen.queryByLabelText(field)).toBeNull();
    }
    expect(
      screen.queryAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA"),
    ).toHaveLength(0);
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
  /** End session opens a confirm now; ending means going through it. */
  async function endNow() {
    await act(async () => {
      endButton()!.click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "End standup" }).click();
    });
  }

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
      .mockImplementation(answering(new Response(null, { status: 204 })));
    renderApp(<StandupRoom env={envelope({ facilitatorId: "marcus" })} me={me} />);
    await endNow();
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
      .mockImplementation(answering(new Response(null, { status: 204 })));
    renderApp(
      <StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />,
    );

    const yesterday = screen.getByLabelText("yesterday");
    fireEvent.change(yesterday, { target: { value: "the very last thing I typed" } });
    // No timer advance: the point is that ending does not wait out the debounce.
    await endNow();

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
      if (String(url).includes("/plugins/panels")) return new Response("[]", { status: 200 });
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT") {
        await held;
      }
      return ok;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getByLabelText("yesterday"), { target: { value: "held open" } });
    act(() => {
      endButton()!.click();
    });
    const ended = act(async () => {
      screen.getByRole("button", { name: "End standup" }).click();
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
      if (String(url).includes("/plugins/panels")) return new Response("[]", { status: 200 });
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT") {
        throw new Error("network down");
      }
      return { status: 204, ok: true, text: async () => "" } as Response;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getByLabelText("yesterday"), { target: { value: "never made it" } });
    await endNow();

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
      if (String(url).includes("/plugins/panels")) return new Response("[]", { status: 200 });
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT" && failNext) {
        throw new Error("network down");
      }
      return { status: 204, ok: true, text: async () => "" } as Response;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getByLabelText("yesterday"), { target: { value: "first go" } });
    await endNow();
    expect(screen.getByRole("alert").textContent).toMatch(/still open/i);
    expect(endButton()).toBeTruthy();
    expect((endButton() as HTMLButtonElement).disabled).toBe(false);

    failNext = false;
    fireEvent.change(screen.getByLabelText("yesterday"), { target: { value: "second go" } });
    await endNow();
    expect(
      fetchSpy.mock.calls.filter(([u, i]) => u === "/api/sessions/sess-1" && (i as RequestInit)?.method === "DELETE"),
    ).toHaveLength(1);
    fetchSpy.mockRestore();
  });

  it("issues one DELETE however fast End is clicked twice", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/plugins/panels")) return new Response("[]", { status: 200 });
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT") {
        await held;
      }
      return { status: 204, ok: true, text: async () => "" } as Response;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getByLabelText("yesterday"), { target: { value: "one save" } });
    // The second click used to land while the flush was still held. It cannot
    // any more: confirming unmounts the modal and disables End session for the
    // duration, so the race is closed structurally rather than only by the ref.
    // The ref guard stays as defence for any caller that is not the modal.
    act(() => {
      endButton()!.click();
    });
    act(() => {
      screen.getByRole("button", { name: "End standup" }).click();
    });
    expect(screen.queryByRole("button", { name: "End standup" })).toBeNull();
    expect((endButton() as HTMLButtonElement).disabled).toBe(true);
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
      if (String(url).includes("/plugins/panels")) return new Response("[]", { status: 200 });
      if (String(url).endsWith("/actions/standup") && (init as RequestInit)?.method === "PUT") {
        puts += 1;
        if (puts === 1) await held;
      }
      return { status: 204, ok: true, text: async () => "" } as Response;
    });
    renderApp(<StandupRoom env={envelope({ phase: "", facilitatorId: "marcus" })} me={me} />);

    fireEvent.change(screen.getByLabelText("yesterday"), { target: { value: "in flight" } });
    // Let the debounce fire, so the PUT is out and nothing is left pending.
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    const putsBeforeEnd = puts;

    act(() => {
      endButton()!.click();
    });
    const ended = act(async () => {
      screen.getByRole("button", { name: "End standup" }).click();
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
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    answering(new Response(null, { status: 204 })),
  );
}

describe("StandupRoom readiness", () => {
  afterEach(() => vi.restoreAllMocks());

  it("round-trips the ready toggle through the ready action", async () => {
    const f = mockFetch();
    renderApp(<StandupRoom env={gathering()} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: /i'm ready/i }));
    expect(roomCalls(f)).toHaveLength(1);
    const [path, init] = roomCalls(f)[0] as [string, RequestInit];
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
    const [, init] = roomCalls(f)[0] as [string, RequestInit];
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
    // The roster names who the room is waiting on rather than listing every
    // speaker with one bit each. Readiness is still carried in words: the
    // heading says what the names mean, and colour is never the only copy.
    const who = screen.getByTestId("ready-roster");
    expect(who.textContent).toMatch(/still writing/i);
    expect(who.textContent).toMatch(/Marcus Okonjo/);
    expect(who.textContent).toMatch(/Priya Raman/);
    // Dana is ready, so the room is not waiting on her and she is not named.
    expect(who.textContent).not.toMatch(/Dana Whitfield/);
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

  it("does not count a live guest, who has no entry row, toward the ready denominator", () => {
    // A link guest is seated as a non-spectator participant (#304), but the
    // server only ever creates a standup_entries row for a member — a guest
    // has no members row at all, so it can never appear in st.entries. Until
    // guests get an actual seat in the round, counting them here makes the
    // denominator permanently unreachable and leaves them stuck in
    // waitingOn forever.
    renderApp(
      <StandupRoom
        env={gathering(
          {
            facilitatorId: "marcus",
            participants: [
              makePerson({ userId: "dana", name: "Dana Whitfield" }),
              makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
              makePerson({ userId: "priya", name: "Priya Raman" }),
              makePerson({ userId: "guest-1", name: "Gabe Guest" }),
            ],
          },
          [
            { userId: "dana", position: 1, ready: true },
            { userId: "marcus", position: 2, ready: true },
            { userId: "priya", position: 3, ready: true },
          ],
        )}
        me={me}
      />,
    );
    expect(startButton().textContent).toMatch(/3 of 3 ready/);
    expect(screen.getByTestId("ready-roster").textContent).toMatch(/everyone is ready/i);
    expect(screen.getByTestId("ready-roster").textContent).not.toMatch(/Gabe Guest/);
  });

  it("still counts a real non-spectator member toward the ready denominator", () => {
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
    const who = screen.getByTestId("ready-roster");
    expect(who.textContent).toMatch(/Priya Raman/);
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

describe("StandupRoom Daybreak", () => {
  it("carries the round's progress in the field, the way the poker table does", () => {
    // Same metaphor, same accumulator, keyed to turns taken rather than votes
    // cast: the room's morning gets lighter as the round goes round.
    renderApp(<StandupRoom env={envelope()} me={me} />);
    // Dana is first of three, so no turn is behind us yet.
    expect(screen.getByTestId("round-bar").getAttribute("data-cue")).toBe("overcast");
  });

  it("reaches full day once the round is done", () => {
    const env = envelope({ phase: "done", state: standupState(null) });
    renderApp(<StandupRoom env={env} me={me} />);
    expect(screen.getByTestId("round-bar").getAttribute("data-cue")).toBe("day");
  });

  it("numbers the seats so the order is read, not counted", () => {
    renderApp(<StandupRoom env={envelope()} me={me} />);
    // The rail is an <ol> that rendered no ordinals at all.
    expect(seat("Marcus Okonjo").textContent).toMatch(/^2/);
    expect(seat("Dana Whitfield").textContent).toMatch(/^1/);
  });

  it("tells a skipped seat apart from one that simply said nothing", () => {
    // Both rendered an identical em dash, though the rail knew the difference.
    const env = envelope({ state: standupState("priya") });
    renderApp(<StandupRoom env={env} me={me} />);
    const body = screen.getByTestId("entry-body");
    expect(body.textContent).toMatch(/skipped|absent/i);
    // An unwritten field said its nothing with a bare em dash, identical to
    // what a skipped seat showed. It says which nothing it is now.
    expect(body.querySelectorAll("dd").length).toBe(3);
    for (const dd of body.querySelectorAll("dd")) {
      expect(dd.textContent).toBe("Nothing written");
    }
    // And a skipped person's words are still readable — that is the point of
    // being able to open their seat at all.
    expect(body.querySelector("dl")).not.toBeNull();
  });

  it("says nothing was in the way with the round's own art, not a bare line", () => {
    const env = envelope({ phase: "done", state: standupState(null) });
    renderApp(<StandupRoom env={env} me={me} />);
    expect(screen.getByText(/No blockers today/i)).toBeTruthy();
    // The art is the daybreak horizon, not the poker card stack — a standup
    // has never had a deck in it.
    expect(screen.getByTestId("daybreak-art")).toBeTruthy();
  });
});

describe("StandupRoom hardening", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("asks before ending the standup for everyone", async () => {
    // It fired a DELETE from a bare 13px label in the chrome, a cursor-width
    // from Export CSV, with nothing in between.
    const del = vi.spyOn(globalThis, "fetch").mockImplementation(
      answering(new Response("nope", { status: 500 })),
    );
    renderApp(<StandupRoom env={envelope()} me={dana} />);
    screen.getByRole("button", { name: "End session" }).click();
    expect(await screen.findByText("End this standup?")).toBeTruthy();
    expect(roomCalls(del)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(roomCalls(del)).toHaveLength(0);
    del.mockRestore();
  });

  it("lets you fix your own update after your turn has passed", async () => {
    // The form rendered only while it was your turn, so a blocker remembered
    // during someone else's turn had nowhere to go — and the roundup at the
    // end is built from exactly that field.
    const env = envelope({ state: standupState("dana") });
    renderApp(<StandupRoom env={env} me={me} />);
    // Marcus is not speaking; his seat is not the one on show.
    await userEvent.click(screen.getByRole("button", { name: "Edit your update" }));
    expect(screen.getAllByRole("textbox").length).toBe(3);
  });

  it("does not offer the edit shortcut once the session has ended", () => {
    const env = envelope({ phase: "done", state: standupState(null) });
    renderApp(<StandupRoom env={env} me={me} />);
    expect(screen.queryByRole("button", { name: "Edit your update" })).toBeNull();
  });

  it("says so when the clipboard refuses, instead of looking broken", async () => {
    // navigator.clipboard is undefined on an insecure origin, which is exactly
    // where a self-hoster on plain HTTP lives.
    const env = envelope({ phase: "done", state: filledState(null) });
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    renderApp(<StandupRoom env={env} me={me} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy blockers" }));
    expect(await screen.findByText(/could not copy/i)).toBeTruthy();
  });
});

describe("StandupRoom clarity", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("names what Skip acts on, since there is only one thing it can do", async () => {
    // "Skip / absent" read as two actions over one boolean. internal/standup
    // has a single facilitator-only `skip` and a single `skipped` column, so
    // the second half of that label described a state that does not exist.
    renderApp(<StandupRoom env={envelope()} me={dana} />);
    expect(screen.queryByRole("button", { name: "Skip / absent" })).toBeNull();
    expect(screen.getByRole("button", { name: "Skip turn" })).toBeTruthy();
  });

  it("says the same thing about a skipped seat everywhere it says anything", () => {
    renderApp(<StandupRoom env={envelope({ state: standupState("priya") })} me={me} />);
    expect(seat("Ben Alvarez") ?? seat("Priya Raman")).toBeTruthy();
    expect(screen.getByTestId("entry-body").textContent).toMatch(/turn skipped/i);
    expect(screen.getByTestId("entry-body").textContent).not.toMatch(/absent/i);
  });

  it("shows how long a turn is, not only to a screen reader", () => {
    // The Timer's sr-only text already said it. Nothing on screen did, and the
    // length is a session setting with no UI to change it.
    renderApp(<StandupRoom env={envelope()} me={me} />);
    expect(screen.getByTestId("turn-length").textContent).toBe("90s each");
  });

  it("gives every field a prompt, not just blockers", () => {
    renderApp(<StandupRoom env={envelope({ phase: "gathering" })} me={me} />);
    for (const box of screen.getAllByRole("textbox")) {
      expect((box as HTMLTextAreaElement).placeholder).not.toBe("");
    }
  });
});

describe("StandupRoom polish", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 12 };

  it("reports a failed round action beside the control that raised it", async () => {
    // One `error` string at the foot of the page received failures from ready,
    // start, next, skip and end alike — the poker room fixed the same shape in
    // #223 and this page kept it.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        answering(new Response(JSON.stringify({ error: "Could not move to the next turn." }), { status: 500 })),
      );
    renderApp(<StandupRoom env={envelope()} me={dana} />);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not move to the next turn/);
    expect(screen.getByTestId("facilitator-bar").parentElement!.contains(alert)).toBe(true);
    fetchSpy.mockRestore();
  });

  it("offers Try again on a failed turn advance, and lets it be dismissed", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        answering(new Response(JSON.stringify({ error: "Could not move to the next turn." }), { status: 500 })),
      );
    renderApp(<StandupRoom env={envelope()} me={dana} />);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    await userEvent.click(within(alert).getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fetchSpy.mockRestore();
  });

  it("names only who the room is still waiting on", async () => {
    // Six speakers meant six rows carrying one bit each, five of which said
    // the thing nobody is waiting to hear.
    const env = envelope();
    (env.state as unknown as { entries: StandupEntry[] }).entries[0].ready = true;
    renderApp(<StandupRoom env={envelope({ phase: "gathering", state: readyState() })} me={me} />);
    const roster = screen.getByTestId("ready-roster");
    expect(roster.textContent).toMatch(/Marcus Okonjo/);
    expect(roster.textContent).not.toMatch(/Dana Whitfield/);
  });

  it("says so plainly when the whole room is ready", () => {
    renderApp(<StandupRoom env={envelope({ phase: "gathering", state: allReadyState() })} me={me} />);
    expect(screen.getByTestId("ready-roster").textContent).toMatch(/everyone is ready/i);
  });

  it("recaps who never got a turn when the round is done", () => {
    // The blockers roundup carried the round's other outcome and this one went
    // unsaid, though the rail knew it all along.
    const env = envelope({ phase: "done", state: standupState(null) });
    renderApp(<StandupRoom env={env} me={me} />);
    const recap = screen.getByTestId("skipped-recap");
    expect(recap.textContent).toMatch(/Priya Raman/);
    // It belongs to the round's summary, not loose on the page beside it.
    expect(recap.closest("section")!.textContent).toMatch(/Blockers roundup/);
  });

  it("says nothing about skips when nobody was skipped", () => {
    renderApp(<StandupRoom env={envelope({ phase: "done", state: noSkipState() })} me={me} />);
    expect(screen.queryByTestId("skipped-recap")).toBeNull();
  });

  it("houses the gathering screen like every other state", () => {
    // It floated on bare felt while the round bar and the speaker card both
    // sat in panels.
    renderApp(<StandupRoom env={envelope({ phase: "gathering" })} me={me} />);
    const form = screen.getByLabelText("yesterday");
    const panel = form.closest("section")!;
    expect(panel.className).toContain("rounded-panel");
    expect(panel.className).toContain("bg-surface");
  });
});

describe("StandupRoom link guest", () => {
  it("never offers facilitator controls to a guest, even when the guest id matches the facilitator id", () => {
    // The pathological coincidence: a guest whose id happens to equal the
    // room's facilitatorId. `env.facilitatorId === me.id` alone would read
    // true here — only the `!guest &&` guard keeps it refused.
    const guestMe: Me = { id: "dana", name: "Priya Raman", avatarHue: 200 };
    renderApp(
      <StandupRoom env={envelope({ phase: "gathering" })} me={guestMe} guest />,
    );
    expect(screen.queryByRole("button", { name: /start the round/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
    expect(screen.queryByText("Export CSV")).toBeNull();
    // The ordinary participant affordance stays — a guest still gets to
    // mark itself ready for its own turn.
    expect(screen.getByRole("button", { name: "I'm ready" })).toBeTruthy();
  });
});

describe("StandupRoom facilitator controls", () => {
  const dana: Me = { id: "dana", name: "Dana Whitfield", avatarHue: 200 };

  it("hands the chair to a named participant in one action", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering(new Response(null, { status: 204 })));
    renderApp(<StandupRoom env={envelope()} me={dana} />);

    await userEvent.click(screen.getByRole("button", { name: /hand off/i }));
    const roster = screen.getByRole("dialog");
    await userEvent.click(within(roster).getByRole("button", { name: /Priya Raman/ }));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sessions/sess-1/facilitator",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ userId: "priya" }) }),
    );
    fetchSpy.mockRestore();
  });

  it("never offers the handoff to an ordinary seat or a link guest", () => {
    renderApp(<StandupRoom env={envelope()} me={me} />);
    expect(screen.queryByRole("button", { name: /hand off/i })).toBeNull();

    renderApp(<StandupRoom env={envelope()} me={dana} guest />);
    expect(screen.queryByRole("button", { name: /hand off/i })).toBeNull();
  });

  it("offers the chair once the stranded facilitator's grace period is over", () => {
    renderApp(
      <StandupRoom
        env={envelope({
          facilitatorConnected: false,
          facilitatorOfflineSince: "2026-08-18T09:58:00.000Z",
        })}
        me={me}
      />,
    );
    const btn = screen.getByRole("button", { name: /^Claim/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("keeps the claim inert while the facilitator is still connected", () => {
    renderApp(<StandupRoom env={envelope()} me={me} />);
    expect(screen.queryByRole("button", { name: /^Claim/ })).toBeNull();
  });

  it("announces the new facilitator to everyone in the room", async () => {
    const { rerender } = renderApp(<StandupRoom env={envelope()} me={me} />);
    rerender(<StandupRoom env={envelope({ facilitatorId: "marcus", version: 2 })} me={me} />);
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((n) => n.textContent === "You're the facilitator now"),
      ).toBe(true),
    );
  });
});

/** A gathering standup carrying some open commitments. */
function carrying(cs: Partial<Commitment>[], over: Partial<Envelope> = {}): Envelope {
  const env = gathering(over);
  const st = env.state as unknown as { commitments: Commitment[] };
  st.commitments = cs.map((c, i) => ({
    id: `c${i + 1}`,
    userId: "marcus",
    text: `commitment ${i + 1}`,
    carried: 0,
    stuck: false,
    openedHere: false,
    ...c,
  }));
  return env;
}

const section = () => screen.getByTestId("carrying-over");
const row = (text: string) =>
  screen.getAllByRole("listitem").find((li) => li.textContent?.includes(text))!;

describe("StandupRoom carrying over", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the section with an empty state on a first-ever standup", () => {
    // No commitments key at all: the very first standup in a space renders the
    // block with words in it rather than a blank gap above the fields.
    renderApp(<StandupRoom env={gathering()} me={me} />);
    expect(section().textContent).toMatch(/carrying over/i);
    expect(screen.getByTestId("carrying-over-empty").textContent).toMatch(/nothing carrying over/i);
  });

  it("lists only your own commitments — somebody else's are not yours to answer", () => {
    renderApp(
      <StandupRoom
        env={carrying([{ text: "mine" }, { userId: "dana", text: "dana's thing" }])}
        me={me}
      />,
    );
    expect(section().textContent).toMatch(/mine/);
    expect(section().textContent).not.toMatch(/dana's thing/);
  });

  it("says a commitment is stuck in prose about the work, with the count as data", () => {
    renderApp(
      <StandupRoom
        env={carrying([
          { text: "stalled thing", carried: 2, stuck: true },
          { text: "fresh thing", carried: 1, stuck: false },
        ])}
        me={me}
      />,
    );
    const badge = within(row("stalled thing")).getByTestId("stuck-badge");
    expect(badge.textContent).toMatch(/stuck/i);
    expect(badge.textContent).toMatch(/carried over/i);
    // About the work, never about the person keeping it.
    expect(badge.textContent).not.toMatch(/\byou\b/i);
    // The numeral is the only data in the sentence, so it is mono and tabular
    // while the words around it stay sans.
    const count = within(badge).getByText("2");
    expect(count.className).toMatch(/font-mono/);
    expect(count.className).toMatch(/tabular-nums/);
    // Not stop, and not any state hue at all: stop is reserved for destructive
    // and stop actions, and this is quiet prose rather than a pill.
    expect(badge.className).not.toMatch(/\btext-stop\b/);
    expect(badge.className).not.toMatch(/\btext-accent\b/);
    expect(within(row("fresh thing")).queryByTestId("stuck-badge")).toBe(null);
  });

  it("drops the last-time subtitle when there was no last time", () => {
    renderApp(<StandupRoom env={gathering()} me={me} />);
    expect(section().textContent).not.toMatch(/what you took on last time/i);
  });

  it("keeps the last-time subtitle once something is carrying over", () => {
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    expect(section().textContent).toMatch(/what you took on last time/i);
  });

  it("never lets a departed member's stale entry push position past the count", async () => {
    // st.entries keeps a row for everyone who ever had one; speakers counts
    // only current, non-spectator participants. Reading the numerator from
    // the first set and the denominator from the second could print "3 / 2".
    // Priya is third in st.entries but has left, so she is not a speaker.
    // With her as the current speaker the old numerator read 3 while the
    // denominator counted the two who remain: "3 / 2".
    renderApp(
      <StandupRoom
        env={envelope({
          participants: [
            makePerson({ userId: "dana", name: "Dana Whitfield" }),
            makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
          ],
          state: standupState("priya"),
        })}
        me={me}
      />,
    );
    const progress = screen.getByTestId("round-progress");
    const [num, denom] = (progress.textContent ?? "").match(/\d+/g)!.map(Number);
    expect(denom).toBe(2);
    expect(num).toBeLessThanOrEqual(denom);
  });

  it("holds the round clock through the whole page when the socket drops", async () => {
    // The Timer's own held-clock branch is unit-tested; this pins the wiring
    // that decides when to use it, which an inverted condition passed.
    renderApp(<StandupRoom env={envelope()} me={me} status="reconnecting" />);
    expect(screen.getByText(/clock held/i)).toBeTruthy();
  });

  it("runs the round clock normally while the socket is live", async () => {
    renderApp(<StandupRoom env={envelope()} me={me} status="live" />);
    expect(screen.queryByText(/clock held/i)).toBeNull();
  });

  it("keeps never-answered apart from answered no", async () => {
    const f = mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }, { text: "beta" }])} me={me} />);
    // Both start unanswered: neither says "not yet".
    expect(row("alpha").textContent).not.toMatch(/not yet/i);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /no/i }));
    await waitFor(() => expect(row("alpha").textContent).toMatch(/not yet/i));
    // Beta was never answered, so it must not be rendered as a No.
    expect(row("beta").textContent).not.toMatch(/not yet/i);
    expect(within(row("beta")).getByRole("button", { name: /no/i })).toBeDefined();
    const [path, init] = roomCalls(f)[0] as [string, RequestInit];
    expect(path).toBe("/api/sessions/sess-1/actions/answer");
    expect(JSON.parse(init.body as string)).toEqual({ id: "c1", done: false });
  });

  it("keeps a no recoverable, instead of a dead sentence", async () => {
    // Swapping the buttons for static text made a misclick in the ninety
    // seconds before your turn unrecoverable for the rest of the sitting. The
    // way back is Change rather than a permanently live pair: a no leaves the
    // commitment open, so re-answering it is a real action.
    mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /^no$/i }));
    await waitFor(() => expect(row("alpha").textContent).toMatch(/not yet/i));
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /change/i }));
    expect(within(row("alpha")).getByRole("button", { name: /^yes$/i })).toBeDefined();
    expect(within(row("alpha")).getByRole("button", { name: /^no$/i })).toBeDefined();
    expect(row("alpha").textContent).not.toMatch(/not yet/i);
  });

  it("sends done:true for yes, and never a userId", async () => {
    const f = mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /yes/i }));
    const [path, init] = roomCalls(f)[0] as [string, RequestInit];
    expect(path).toBe("/api/sessions/sess-1/actions/answer");
    expect(JSON.parse(init.body as string)).toEqual({ id: "c1", done: true });
  });

  it("adds a commitment through the add action and clears the box", async () => {
    const f = mockFetch();
    renderApp(<StandupRoom env={gathering()} me={me} />);
    const box = screen.getByLabelText(/add a commitment/i) as HTMLInputElement;
    await userEvent.type(box, "ship the thing");
    await userEvent.click(within(section()).getByRole("button", { name: /^add$/i }));
    const [path, init] = roomCalls(f)[0] as [string, RequestInit];
    expect(path).toBe("/api/sessions/sess-1/actions/add");
    expect(JSON.parse(init.body as string)).toEqual({ text: "ship the thing" });
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("removes a commitment through the remove action, once it is confirmed", async () => {
    const f = mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    // Destructive and unrecoverable, so the first click only asks.
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /^remove$/i }));
    expect(roomCalls(f)).toHaveLength(0);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /remove it/i }));
    const [path, init] = roomCalls(f)[0] as [string, RequestInit];
    expect(path).toBe("/api/sessions/sess-1/actions/remove");
    expect(JSON.parse(init.body as string)).toEqual({ id: "c1" });
  });

  it("gives a keyboard two real steps: Enter on Remove twice does not delete", async () => {
    // The confirming and non-confirming states used to render the same element
    // types with no key, so React reconciled in place: the focused button stayed
    // the focused button while its accessible name silently mutated from Remove
    // to "Remove it". Two Enter presses then deleted the commitment with no
    // second step at all for anyone not watching the label change.
    const f = mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    const remove = within(row("alpha")).getByRole("button", { name: /^remove$/i });
    remove.focus();
    await userEvent.keyboard("{Enter}");
    // The safe choice leads, and it is where focus went — so a repeated Enter
    // cannot land on the destructive one.
    const labels = within(row("alpha"))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels.indexOf("Keep it")).toBeLessThan(labels.indexOf("Remove it"));
    expect(document.activeElement?.textContent).toBe("Keep it");
    // And the change is announced through the page's one polite region.
    expect(screen.getByRole("status").textContent).toMatch(/remove this commitment/i);

    await userEvent.keyboard("{Enter}");
    expect(roomCalls(f)).toHaveLength(0);
    // Back to the first step, not deleted.
    expect(within(row("alpha")).getByRole("button", { name: /^remove$/i })).toBeDefined();
  });

  it("dismisses the remove confirm on Escape", async () => {
    const f = mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /^remove$/i }));
    expect(within(row("alpha")).getByRole("button", { name: /remove it/i })).toBeDefined();
    await userEvent.keyboard("{Escape}");
    expect(roomCalls(f)).toHaveLength(0);
    expect(within(row("alpha")).queryByRole("button", { name: /remove it/i })).toBe(null);
    expect(within(row("alpha")).getByRole("button", { name: /^remove$/i })).toBeDefined();
  });

  it("returns focus to Remove after the confirm is cancelled", async () => {
    mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    // Escape path: the confirm is a fresh node, so the restored Remove is too.
    within(row("alpha"))
      .getByRole("button", { name: /^remove$/i })
      .focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(row("alpha")).getByRole("button", { name: /^remove$/i }),
      ),
    );
    // And the Keep it path lands in the same place.
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(row("alpha")).getByRole("button", { name: /^remove$/i }),
      ),
    );
  });

  it("backs out of a remove without sending anything", async () => {
    const f = mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /^remove$/i }));
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /keep it/i }));
    expect(roomCalls(f)).toHaveLength(0);
    expect(within(row("alpha")).getByRole("button", { name: /^remove$/i })).toBeDefined();
  });

  it("resolves a yes in place instead of leaving the button looking dead", async () => {
    mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /^yes$/i }));
    await waitFor(() => expect(row("alpha").textContent).toMatch(/landed/i));
    expect(within(row("alpha")).queryByRole("button", { name: /^yes$/i })).toBe(null);
    // No "Change" on the yes path: the server has already closed the
    // commitment and will not reopen it, so a control offering to take the
    // answer back could only produce a 404.
    expect(within(row("alpha")).queryByRole("button", { name: /change/i })).toBe(null);
  });

  it("holds a landed row for a beat after the broadcast sweeps it away", async () => {
    mockFetch();
    const { rerender } = renderApp(
      <StandupRoom env={carrying([{ text: "alpha" }, { text: "beta" }])} me={me} />,
    );
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /^yes$/i }));
    await waitFor(() => expect(row("alpha").textContent).toMatch(/landed/i));
    // Yes closes the commitment server-side, so the very next broadcast no
    // longer carries it. Without the hold the acknowledgement is a flash.
    rerender(<StandupRoom env={carrying([{ id: "c2", text: "beta" }])} me={me} />);
    expect(row("alpha").textContent).toMatch(/landed/i);
    // And it does leave: the hold is a beat, not a cache.
    await waitFor(
      () =>
        expect(
          screen.queryAllByRole("listitem").some((li) => li.textContent?.includes("alpha")),
        ).toBe(false),
      { timeout: 3000 },
    );
    // The row that stayed open is untouched by any of it.
    expect(row("beta").textContent).toMatch(/beta/);
  });

  it("keeps Remove out of the answer pair, so it never reads as a third answer", () => {
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    const answers = within(row("alpha")).getByTestId("answer-group");
    expect(within(answers).getByRole("button", { name: /^yes$/i })).toBeDefined();
    expect(within(answers).getByRole("button", { name: /^no$/i })).toBeDefined();
    expect(within(answers).queryByRole("button", { name: /^remove$/i })).toBe(null);
    // Still on the row, just not in the group that answers the question.
    expect(within(row("alpha")).getByRole("button", { name: /^remove$/i })).toBeDefined();
  });

  it("lets a mis-clicked answer be changed back", async () => {
    mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /^no$/i }));
    await waitFor(() => expect(row("alpha").textContent).toMatch(/not yet/i));
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /change/i }));
    expect(row("alpha").textContent).not.toMatch(/not yet/i);
    expect(within(row("alpha")).getByRole("button", { name: /^yes$/i })).toBeDefined();
  });

  it("keeps focus in the row after an answer instead of dropping it on the body", async () => {
    mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /^no$/i }));
    await waitFor(() => expect(document.activeElement).toBe(row("alpha")));
  });

  it("announces an answer through the one polite region the page already has", async () => {
    mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    await userEvent.click(within(row("alpha")).getByRole("button", { name: /^yes$/i }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((n) => /landed/i.test(n.textContent ?? "")),
      ).toBe(true),
    );
  });

  it("sends one answer for a double click", async () => {
    const f = mockFetch();
    renderApp(<StandupRoom env={carrying([{ text: "alpha" }])} me={me} />);
    const yes = within(row("alpha")).getByRole("button", { name: /^yes$/i });
    fireEvent.click(yes);
    fireEvent.click(yes);
    await waitFor(() => expect(row("alpha").textContent).toMatch(/landed/i));
    expect(roomCalls(f)).toHaveLength(1);
  });
});

describe("StandupRoom gathering panel and fresh commitments", () => {
  afterEach(() => vi.restoreAllMocks());

  // The action bar is pulled out to the panel's edges with negative margins and
  // paints its own bg-surface. Square corners there sit on top of the parent's
  // rounded-panel and put a squared-off block back in both bottom corners.
  it("carries the panel's bottom radius on the pulled-out action bar", () => {
    renderApp(<StandupRoom env={gathering()} me={me} />);
    const bar = screen.getByTestId("gathering-actions");
    expect(bar.className).toContain("bg-surface");
    expect(bar.className).toContain("-mb-5");
    expect(bar.className).toContain("rounded-b-panel");
  });

  // A commitment opened in this very sitting has carried from nowhere, so
  // "What you took on last time. Did that land?" is the wrong question about
  // it — and answering No would move a carry count it never earned.
  it("keeps a commitment made in this sitting out of the carry-over list", () => {
    renderApp(
      <StandupRoom
        env={carrying([
          { text: "from yesterday", openedHere: false },
          { text: "typed just now", openedHere: true },
        ])}
        me={me}
      />,
    );
    const over = screen.getByTestId("carrying-over-list");
    expect(over.textContent).toMatch(/from yesterday/);
    expect(over.textContent).not.toMatch(/typed just now/);

    const now = screen.getByTestId("taking-on-now");
    expect(now.textContent).toMatch(/typed just now/);
    // No question is asked about it, so there is nothing to answer.
    expect(within(row("typed just now")).queryByRole("button", { name: /^yes/i })).toBe(null);
    expect(within(row("typed just now")).queryByRole("button", { name: /^no/i })).toBe(null);
    // It is still yours to withdraw.
    expect(within(row("typed just now")).getByRole("button", { name: /remove/i })).toBeDefined();
  });

  // With nothing carried in, the carry-over block must say so rather than
  // quietly listing this sitting's new commitment under last time's heading.
  it("says nothing is carrying over when everything open was made just now", () => {
    renderApp(<StandupRoom env={carrying([{ text: "typed just now", openedHere: true }])} me={me} />);
    expect(screen.getByTestId("carrying-over-empty").textContent).toMatch(/nothing carrying over/i);
  });
});


/** The closing beat: kudos given in the room, and the form that gives them. */
type WireKudo = { id: string; fromUserId: string; toUserId: string; text: string };
function kudoState(kudos: WireKudo[]): Envelope["state"] {
  const st = standupState(null) as unknown as { kudos: WireKudo[] };
  st.kudos = kudos;
  return st as unknown as Envelope["state"];
}
const doneEnv = (kudos: WireKudo[] = [], over: Partial<Envelope> = {}) =>
  envelope({ phase: "done", state: kudoState(kudos), ...over });

describe("StandupRoom kudos", () => {
  it("gives a kudo through the round's own action", async () => {
    // The whole page, driven the way a person drives it: pick a name, say what
    // they did, submit. A test that hands the panel a kudo proves the markup
    // renders, not that the room can produce one.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(answering(new Response(null, { status: 204 })));
    renderApp(<StandupRoom env={doneEnv()} me={me} />);

    await userEvent.selectOptions(screen.getByLabelText(/thank/i), "dana");
    await userEvent.type(screen.getByLabelText(/for what/i), "unstuck the deploy");
    await userEvent.click(screen.getByRole("button", { name: /give kudos/i }));

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.filter(
          ([url, init]) =>
            url === "/api/sessions/sess-1/actions/kudo" &&
            (init as RequestInit).method === "POST" &&
            (init as RequestInit).body ===
              JSON.stringify({ to: "dana", text: "unstuck the deploy" }),
        ),
      ).toHaveLength(1),
    );
    fetchSpy.mockRestore();
  });

  it("counts the kudo text in runes, not UTF-16 units", () => {
    // The server counts runes too ([...text].length), and an emoji is a
    // surrogate pair: one rune, two UTF-16 code units. fireEvent.change (not
    // userEvent.type, which drives one keystroke per UTF-16 unit and is both
    // slow and wrong here) sets the value in one shot so the pair lands intact.
    renderApp(<StandupRoom env={doneEnv()} me={me} />);

    const field = screen.getByLabelText(/for what/i);
    fireEvent.change(field, { target: { value: "🎉" } });

    expect(screen.getByText("279").textContent).toBe("279");
  });

  it("disables submission and marks the field invalid past 280 runes", () => {
    renderApp(<StandupRoom env={doneEnv()} me={me} />);

    const field = screen.getByLabelText(/for what/i);
    fireEvent.change(field, { target: { value: "🎉".repeat(281) } });

    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(
      (screen.getByRole("button", { name: /give kudos/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows a kudo another client gave, on the broadcast alone", () => {
    // The second connected client: no refetch of its own, just the next
    // envelope the room was pushed. The panel has to read the kudo out of
    // state rather than out of a response it never saw.
    const { rerender } = renderApp(<StandupRoom env={doneEnv()} me={me} />);
    expect(screen.queryByTestId("standup-kudos")).toBeNull();

    rerender(
      <StandupRoom
        env={doneEnv([{ id: "k1", fromUserId: "dana", toUserId: "priya", text: "unstuck the deploy" }], {
          version: 2,
        })}
        me={me}
      />,
    );

    const panel = screen.getByTestId("standup-kudos");
    expect(panel.textContent).toContain("Dana Whitfield");
    expect(panel.textContent).toContain("Priya Raman");
    expect(panel.textContent).toContain("unstuck the deploy");
  });

  it("skips the closing panel entirely rather than empty-stating it", () => {
    // A guest can neither send nor receive, so with nothing given there is
    // nothing for it in the beat at all — and nowhere does a "no kudos yet"
    // line appear for anybody.
    renderApp(<StandupRoom env={doneEnv()} me={me} guest />);
    expect(screen.queryByTestId("standup-kudos")).toBeNull();
    expect(screen.queryByText(/no kudos/i)).toBeNull();
  });

  it("shows a guest the beat but never the form", () => {
    // Said plainly: the envelope reaches every socket in the room, so a guest
    // reads what was said in the room it is in. It just cannot say it.
    renderApp(
      <StandupRoom
        env={doneEnv([{ id: "k1", fromUserId: "dana", toUserId: "priya", text: "unstuck the deploy" }])}
        me={me}
        guest
      />,
    );
    expect(screen.getByTestId("standup-kudos").textContent).toContain("unstuck the deploy");
    expect(screen.queryByRole("button", { name: /give kudos/i })).toBeNull();
  });

  it("does not offer a guest as a recipient", () => {
    renderApp(
      <StandupRoom
        env={doneEnv([], {
          participants: [
            makePerson({ userId: "dana", name: "Dana Whitfield" }),
            makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
            makePerson({ userId: "vic", name: "Visiting Vic", guest: true }),
          ],
        })}
        me={me}
      />,
    );
    const names = Array.from(
      screen.getByLabelText(/thank/i).querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(names).toContain("Dana Whitfield");
    expect(names).not.toContain("Visiting Vic");
    // Nor yourself: the server answers 400.
    expect(names).not.toContain("Marcus Okonjo");
  });

  it("keeps the beat out of the round until it is over", () => {
    renderApp(
      <StandupRoom
        env={envelope({
          phase: "speaking",
          state: kudoState([{ id: "k1", fromUserId: "dana", toUserId: "priya", text: "unstuck the deploy" }]),
        })}
        me={me}
      />,
    );
    expect(screen.queryByTestId("standup-kudos")).toBeNull();
  });
});
