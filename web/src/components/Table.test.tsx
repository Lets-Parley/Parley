import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { Table, faceOf, celebrationBeats, planCelebration } from "./Table";
import { PILE_ON_EMOJI, hopStartsAt, CARD_HOP_MS } from "../lib/motion";
import { makePerson } from "../test/render";

describe("faceOf", () => {
  it("renders the coffee card as its glyph", () => {
    expect(faceOf("coffee")).toBe("☕");
  });

  it("passes every other card through untouched", () => {
    for (const v of ["0", "1", "5", "13", "?", "XL", "½"]) expect(faceOf(v)).toBe(v);
  });
});

const dana = makePerson({ userId: "dana", name: "Dana Whitfield" });
const marcus = makePerson({ userId: "marcus", name: "Marcus Okonjo" });
const priya = makePerson({ userId: "priya", name: "Priya Raman" });

function renderTable(over: Partial<Parameters<typeof Table>[0]> = {}) {
  const ui = () => (
    <Table
      seated={[dana, marcus, priya]}
      spectators={[]}
      online={new Set(["dana", "marcus", "priya"])}
      votedUserIds={[]}
      votes={new Map()}
      revealed={false}
      consensus={false}
      facilitatorId="dana"
      meId="dana"
      {...over}
    />
  );
  const result = render(ui());
  // A websocket frame that changes nothing still re-renders the table. It has
  // to be a fresh element each time: handed back the same one, React sees the
  // identical reference and bails out without re-rendering at all.
  return { ...result, repaint: () => result.rerender(ui()) };
}

const field = () => screen.getByTestId("table-field");

/**
 * Scopes queries to the seat container holding the given first name.
 * When two seats share a first name — an impostor wearing a member's name —
 * pass `userId` to pick the seat by its `data-seat-user`, since a
 * document-wide `getByText` can't tell the seats apart on name alone.
 */
function seat(firstName: string, userId?: string) {
  if (userId !== undefined) {
    const container = document.querySelector(`[data-seat-user="${userId}"]`);
    if (!container) throw new Error(`could not find seat container for userId "${userId}"`);
    return within(container as HTMLElement);
  }
  const nameNode = screen.getByText(firstName);
  const container = nameNode.closest("[data-seat-user]");
  if (!container) throw new Error(`could not find seat container for "${firstName}"`);
  return within(container as HTMLElement);
}

describe("Table", () => {
  // A guest can redeem a link under any name, a member's included, so the seat
  // has to say which one it is. The mark comes from the server.
  it("marks a link guest's seat, even one wearing a member's name", () => {
    const impostor = makePerson({ userId: "guest", name: "Dana Whitfield", guest: true });
    renderTable({
      seated: [dana, impostor],
      online: new Set(["dana", "guest"]),
    });
    // Both seats say "Dana" — the marker has to land on the impostor's seat
    // specifically, and must not also land on the real member's.
    expect(seat("Dana", "guest").queryByText("· guest")).toBeTruthy();
    expect(seat("Dana", "dana").queryByText("· guest")).toBeNull();
  });

  // jsdom does no layout, so this cannot observe whether the marker is
  // visually clipped — it pins the structural property that keeps it safe
  // from truncation instead: the marker must not live inside the element
  // that carries the `truncate` class, or an ellipsis could eat it the way
  // it ate the whole name-plus-marker line before this fix.
  it("keeps the guest and you tells outside the truncating name element", () => {
    const impostor = makePerson({ userId: "guest", name: "A Very Long Guest Display Name", guest: true });
    renderTable({ seated: [dana, impostor], online: new Set(["dana", "guest"]) });

    const youMark = seat("Dana", "dana").getByText("· you");
    const guestMark = seat("A", "guest").getByText("· guest");
    const truncatingAncestor = (node: Element) => node.closest(".truncate");

    expect(truncatingAncestor(youMark)).toBeNull();
    expect(truncatingAncestor(guestMark)).toBeNull();
  });

  it("counts votes against who could still vote while hidden", () => {
    renderTable({ votedUserIds: ["dana", "marcus"] });
    expect(screen.getByText("2 of 3 voted")).toBeTruthy();
  });

  it("lets the count reach N of N when a silent seat drops", () => {
    renderTable({ votedUserIds: ["dana", "marcus"], online: new Set(["dana", "marcus"]) });
    expect(screen.getByText("2 of 2 voted")).toBeTruthy();
  });

  it("switches to a plain total once the round is revealed", () => {
    renderTable({
      revealed: true,
      votes: new Map([
        ["dana", "5"],
        ["marcus", "8"],
      ]),
    });
    expect(screen.getByText("2 votes on the table")).toBeTruthy();
  });

  it("says vote, singular, for one", () => {
    renderTable({ revealed: true, votes: new Map([["dana", "5"]]) });
    expect(screen.getByText("1 vote on the table")).toBeTruthy();
  });

  it("shows an offline seat as away rather than as not yet voted", () => {
    renderTable({ online: new Set(["dana", "marcus"]) });
    expect(screen.getAllByText("zzz")).toHaveLength(1);
  });

  it("shows no away card for a seat that voted before dropping", () => {
    renderTable({ online: new Set(["dana", "marcus"]), votedUserIds: ["priya"] });
    expect(screen.queryByText("zzz")).toBeNull();
  });

  it("shows card faces only once revealed", () => {
    const votes = new Map([["dana", "coffee"]]);
    const { rerender } = renderTable({ votes, votedUserIds: ["dana"] });
    expect(screen.queryByText("☕")).toBeNull();

    rerender(
      <Table
        seated={[dana, marcus, priya]}
        spectators={[]}
        online={new Set(["dana", "marcus", "priya"])}
        votedUserIds={["dana"]}
        votes={votes}
        revealed
        consensus={false}
        facilitatorId="dana"
        meId="dana"
      />,
    );
    expect(screen.getByText("☕")).toBeTruthy();
  });

  it("marks which seat is yours by first name", () => {
    renderTable();
    expect(screen.getByText("Dana")).toBeTruthy();
    expect(screen.getByText("· you")).toBeTruthy();
  });

  it("lists spectators separately and keeps them out of the count", () => {
    const nina = makePerson({ userId: "nina", name: "Nina Kowalski", spectator: true });
    renderTable({ spectators: [nina], votedUserIds: ["dana"] });
    expect(screen.getByText("spectators")).toBeTruthy();
    expect(screen.getByText("1 of 3 voted")).toBeTruthy();
  });

  it("hides the spectator rail when there are none", () => {
    renderTable();
    expect(screen.queryByText("spectators")).toBeNull();
  });

  it("gives every seat state a text equivalent on the card, tied to the right seat", () => {
    renderTable({ online: new Set(["dana", "marcus"]), votedUserIds: ["dana"] });
    // dana: seated + online + voted -> back ("voted")
    // marcus: seated + online + not voted -> empty ("no card yet")
    // priya: seated + offline -> away ("away")
    expect(seat("Dana").getByRole("img", { name: "voted" })).toBeTruthy();
    expect(seat("Marcus").getByRole("img", { name: "no card yet" })).toBeTruthy();
    expect(seat("Priya").getByRole("img", { name: "away" })).toBeTruthy();
  });

  it("keeps an away seat away at the reveal, instead of a blank face card", () => {
    // Before the fix, `revealed` alone forced every seat to "face", so a seat
    // whose owner had left the meeting turned over a blank card and became
    // indistinguishable from a present person who abstained.
    renderTable({
      online: new Set(["dana", "marcus"]), // priya has gone
      revealed: true,
      votes: new Map([["dana", "5"]]),
    });
    expect(seat("Priya").getByRole("img", { name: "away" })).toBeTruthy();
    expect(seat("Priya").queryByRole("img", { name: "no card" })).toBeNull();
  });

  it("still turns a present seat's empty card face-up at the reveal", () => {
    // The other half of the same branch: absence is drawn as absence, but a
    // present abstainer has a card to turn over and still turns it.
    renderTable({
      online: new Set(["dana", "marcus", "priya"]),
      revealed: true,
      votes: new Map([["dana", "5"]]),
    });
    expect(seat("Priya").getByRole("img", { name: "no card" })).toBeTruthy();
    expect(seat("Priya").queryByRole("img", { name: "away" })).toBeNull();
  });

  it("puts every revealed value into the seat's accessible name, tied to the right seat", () => {
    renderTable({
      revealed: true,
      votes: new Map([
        ["dana", "5"],
        ["marcus", "coffee"],
      ]),
    });
    expect(seat("Dana").getByRole("img", { name: "voted 5" })).toBeTruthy();
    expect(seat("Marcus").getByRole("img", { name: "voted coffee" })).toBeTruthy();
    expect(seat("Priya").getByRole("img", { name: "no card" })).toBeTruthy();
  });

  it("announces the tally without repeating a person's name per seat", () => {
    renderTable();
    expect(screen.getByRole("status").textContent).toBe("0 of 3 voted");
    expect(screen.getAllByRole("img", { name: "Dana Whitfield" })).toHaveLength(1);
  });

  it("reports 0 of 0 for an empty table rather than crashing", () => {
    renderTable({ seated: [], online: new Set() });
    expect(screen.getByText("0 of 0 voted")).toBeTruthy();
  });

  // Criterion 7. One live region, or two voices talk over each other.
  it("keeps the count in a single status element", () => {
    renderTable({ votedUserIds: ["dana"], cueState: "first-light" });
    const live = screen.getAllByRole("status");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe("1 of 3 voted");
  });

  // The cue is a wash of colour, and its step names are internal codenames.
  // Printing them told a user nothing the "n of m voted" line does not.
  it("never spells the cue's codename out on screen", () => {
    for (const state of ["overcast", "first-light", "daybreak", "day"] as const) {
      const { container, unmount } = renderTable({ votedUserIds: ["dana"], cueState: state });
      expect(container.textContent).not.toMatch(/overcast|first light|daybreak/i);
      unmount();
    }
  });

  it("says nothing about the light when the light is cut", () => {
    renderTable({ votedUserIds: ["dana"], cueState: null });
    expect(screen.getByRole("status").textContent).toBe("1 of 3 voted");
    expect(field().getAttribute("style")).not.toContain("--cue-");
  });

  // Criterion 8. A helper that finds something is not a helper that scopes.
  it("scopes each seat to its own marks and nobody else's", () => {
    renderTable({ online: new Set(["dana", "marcus"]), votedUserIds: ["dana"] });
    expect(seat("Priya").getByRole("img", { name: "away" })).toBeTruthy();
    expect(seat("Dana").queryByRole("img", { name: "away" })).toBeNull();
    expect(seat("Marcus").queryByRole("img", { name: "away" })).toBeNull();
    expect(seat("Dana").queryByRole("img", { name: "no card yet" })).toBeNull();
  });

  // Criterion 9. Sibling AFTER the ranks, not inline with a divider.
  it("puts the spectator rail below the seat ranks", () => {
    const nina = makePerson({ userId: "nina", name: "Nina Kowalski", spectator: true });
    renderTable({ spectators: [nina] });
    const ranks = screen.getByTestId("seat-ranks");
    const rail = screen.getByTestId("spectator-rail");
    // FOLLOWING, and not CONTAINED_BY: inline-with-a-divider would be inside.
    const rel = ranks.compareDocumentPosition(rail);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rel & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeFalsy();
    expect(rail.parentElement).toBe(ranks.parentElement);
  });

  it("wraps seats into ranks instead of scrolling them sideways", () => {
    // 15 seats need two ranks at every desktop width — 74px + a 12px gap is
    // 86px a seat against a widest row of 884px. jsdom does not lay out, so
    // this asserts the mechanism, not the wrap point.
    const { container } = renderTable();
    expect(screen.getByTestId("seat-ranks").className).toContain("flex-wrap");
    expect(container.querySelector(".overflow-x-auto")).toBeNull();
  });

  // Criterion 3. The animating ground touches exactly one element, and every
  // mark sits on a fixed-luminance token instead.
  it("keeps every mark off the animating field", () => {
    const { container } = renderTable({ votedUserIds: ["dana"], cueState: "daybreak" });
    const cued = container.querySelectorAll('[style*="--cue-"]');
    expect(cued).toHaveLength(1);
    expect(cued[0]).toBe(field());
    expect(seat("Dana").getByRole("img", { name: "voted" }).className).toContain("bg-card-back");
    expect(container.querySelector('[class*="ring-"], [class*="bg-card-back"]')).toBeTruthy();
  });

  // Criterion 4. There is no JS interpolation to stop — the arc is a CSS
  // transition, which tokens.css's reduced-motion rule already kills. What
  // this proves is that nothing schedules frames behind its back.
  it("lands straight on the target state under reduced motion", () => {
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList);
    renderTable({ votedUserIds: ["dana", "marcus"], cueState: "daybreak" });
    expect(field().getAttribute("data-cue")).toBe("daybreak");
    expect(field().getAttribute("style")).toContain("--cue-daybreak");
    expect(raf).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("names the field state for each step of the arc", () => {
    for (const state of ["overcast", "first-light", "daybreak", "day"] as const) {
      const { unmount } = renderTable({ cueState: state });
      expect(field().getAttribute("style")).toContain(`var(--cue-${state})`);
      unmount();
    }
  });

  it("carries the waiting count on the field, and says it only once", () => {
    // It shipped at 11px under the field — unreadable from across the room
    // it is projected into. Big on the field, spoken once by the live region.
    renderTable({ votedUserIds: ["dana"], cueState: "first-light" });
    const big = screen.getByTestId("waiting-count");
    // Pinned exact: votedCount and canVote sit on either side of the slash,
    // so a swap between them would read as plausible if only substrings were
    // checked.
    expect(big.textContent).toBe("1 / 3voted");
    expect(big.className).toContain("text-[1.5rem]");
    expect(big.className).toContain("tabular-nums");
    expect(big.getAttribute("aria-hidden")).toBe("true");
    // One live region, one voice: the count is spoken, not printed twice.
    expect(screen.getByRole("status").textContent).toContain("1 of 3");
    // Before reveal, the live-region span carrying the count must stay
    // sr-only — it duplicates what is already big on the field.
    const liveCountSpan = screen.getByRole("status").querySelector("span:first-child");
    expect(liveCountSpan?.className).toContain("sr-only");
  });

  it("hands the field back to the seats once the votes are up", () => {
    renderTable({ votedUserIds: ["dana"], revealed: true, cueState: "day" });
    expect(screen.queryByTestId("waiting-count")).toBeNull();
    // The seats stay put on reveal — this test's name promises exactly that.
    expect(screen.getByTestId("seat-ranks").children.length).toBe(3);
    // After reveal, the live-region span carrying the count must NOT be
    // sr-only — sighted users need to see it now that the big field number
    // is gone.
    const liveCountSpan = screen.getByRole("status").querySelector("span:first-child");
    expect(liveCountSpan?.className).not.toContain("sr-only");
    expect(screen.getByRole("status").textContent).toContain("1 vote on the table");
  });
});

/** The seat's own element, for the animation styles a `within` scope can't reach. */
function seatEl(userId: string): HTMLElement {
  const el = document.querySelector(`[data-seat-user="${userId}"]`);
  if (!el) throw new Error(`no seat for "${userId}"`);
  return el as HTMLElement;
}

describe("celebrationBeats", () => {
  /* Literal, for the same reason as lib/motion/plan.test.ts: asserting that
     start (defined as cardsLand + 60) exceeds cardsLand is trivially true for
     any value of CARD_HOP_MS, negative ones included. The numbers below are
     (n-1)*70 + 780, worked out by hand. */
  it("waits out the slowest card at every table size", () => {
    expect(celebrationBeats(1, 1).start).toBe(780);
    expect(celebrationBeats(2, 1).start).toBe(850);
    expect(celebrationBeats(6, 3).start).toBe(1130);
    expect(celebrationBeats(15, 8).start).toBe(1760);
    // ...and it is always after the last card has stopped bouncing.
    for (const n of [1, 2, 6, 15]) {
      const cardsLand = hopStartsAt(n - 1) + CARD_HOP_MS;
      expect(celebrationBeats(n, Math.ceil(n / 2)).start).toBeGreaterThan(cardsLand);
    }
  });

  it("keeps the whole ripple inside a fixed budget as the table grows", () => {
    const spread = (groups: number) => celebrationBeats(15, groups).stagger * (groups - 1);
    expect(celebrationBeats(2, 1).stagger).toBe(0);
    expect(spread(2)).toBeLessThanOrEqual(420);
    expect(spread(8)).toBeLessThanOrEqual(420);
  });
});

describe("planCelebration", () => {
  const rows = (n: number, perRank = n) =>
    Array.from({ length: n }, (_, i) => Math.floor(i / perRank));

  it("leans a pair together and bursts once between them", () => {
    const plan = planCelebration(rows(4), true);
    expect(plan[0].animation).toContain("highfive-right");
    expect(plan[1].animation).toContain("highfive-left");
    expect(plan.filter((p) => p.burst)).toHaveLength(2);
  });

  it("fires both halves of a pair on the same beat", () => {
    const plan = planCelebration(rows(4), true);
    expect(plan[0].beat).toBe(plan[1].beat);
    expect(plan[2].beat).toBeGreaterThan(plan[0].beat);
  });

  // Pairing on index alone hands the last seat of an odd rank a partner on
  // the row below — the two then lean at each other across the whole table.
  it("never pairs across a rank break", () => {
    const plan = planCelebration(rows(6, 3), true); // ranks of 3 and 3
    expect(plan[2].animation).toContain("highfive-solo");
    expect(plan[3].animation).toContain("highfive-right");
    expect(plan[2].burst).toBe(false);
  });

  it("gives a rank's odd seat out a solo jump rather than a lean at nobody", () => {
    const plan = planCelebration(rows(3), true);
    expect(plan[2].animation).toContain("highfive-solo");
  });

  // The burst is thrown into the gap to the seat's right, so it has to be the
  // pair's right-hand seat that owns it — hung off the left seat it lands
  // outside the pair instead of between them.
  it("hangs the burst off the pair's right seat", () => {
    const plan = planCelebration(rows(4), true);
    expect(plan[0].burst).toBe(true);
    expect(plan[1].burst).toBe(false);
  });

  it("leaves a rank of one on its own beat with nothing to throw", () => {
    const plan = planCelebration(rows(1), true);
    expect(plan[0].animation).toContain("highfive-solo");
    expect(plan[0].burst).toBe(false);
    expect(plan[0].beat).toBe(celebrationBeats(1, 1).start);
  });

  // The solo isn't its own beat in the ripple — it fires alongside the pair
  // it trails, not after it. A later beat for the solo also inflates
  // groupCount, stretching the ripple's stagger budget for every rank after it.
  it("lands the odd seat out on its rank's last pair's beat", () => {
    const plan = planCelebration(rows(3), true);
    expect(plan[2].beat).toBe(plan[0].beat);

    const mixed = planCelebration(rows(5, 3), true); // ranks of 3 and 2
    expect(mixed[2].beat).toBe(mixed[0].beat);
    expect(mixed[3].beat).toBeGreaterThan(mixed[0].beat);
  });

  it("plans nothing at all when the table did not agree", () => {
    expect(planCelebration(rows(4), false).every((p) => !p.animation && !p.burst)).toBe(true);
  });
});

describe("the consensus high-five", () => {
  const agreed = {
    revealed: true,
    consensus: true,
    votes: new Map([
      ["dana", "5"],
      ["marcus", "5"],
      ["priya", "5"],
    ]),
    votedUserIds: ["dana", "marcus", "priya"],
  };

  it("celebrates a unanimous reveal", () => {
    renderTable(agreed);
    expect(seatEl("dana").querySelector("[style*='highfive-right']")).not.toBeNull();
    expect(seatEl("marcus").querySelector("[style*='highfive-left']")).not.toBeNull();
    expect(screen.getAllByTestId("highfive-burst")).toHaveLength(1);
  });

  // Inside the animating span, every particle would inherit the jump's
  // transform and snap back to the seat when it ended.
  it("anchors the burst outside the jumping avatar", () => {
    renderTable(agreed);
    const burst = screen.getByTestId("highfive-burst");
    expect(burst.closest("[style*='highfive-right']")).toBeNull();
    expect(burst.closest("[data-seat-user]")).not.toBeNull();
  });

  // scatter() stands in for Math.random so confetti survives the table
  // re-rendering on every websocket frame without restarting mid-flight.
  // A real random per render would make this test flaky/red.
  it("throws the same confetti geometry on every render", () => {
    const particleStyles = () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid='highfive-burst'] [style*='--dx']")).map(
        (el) => el.getAttribute("style"),
      );
    const { repaint } = renderTable(agreed);
    const before = particleStyles();
    repaint();
    const after = particleStyles();
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });

  it("stays still when the table did not agree", () => {
    renderTable({ ...agreed, consensus: false });
    expect(screen.queryByTestId("highfive-burst")).toBeNull();
    expect(field().querySelector("[style*='highfive']")).toBeNull();
  });

  it("waits for the reveal before celebrating", () => {
    renderTable({ ...agreed, revealed: false });
    expect(screen.queryByTestId("highfive-burst")).toBeNull();
    expect(field().querySelector("[style*='highfive']")).toBeNull();
  });

  // The global reduced-motion rule only cancels animations; it cannot remove
  // 14 particle nodes per pair, so the celebration is never built at all.
  it("builds no celebration at all under prefers-reduced-motion", () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) =>
      ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      renderTable(agreed);
      expect(screen.queryByTestId("highfive-burst")).toBeNull();
      expect(field().querySelector("[style*='highfive']")).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});

describe("the emoji pile-on", () => {
  const room = ["ana", "ben", "cy", "dee", "eli"].map((id) =>
    makePerson({ userId: id, name: `${id[0].toUpperCase()}${id.slice(1)} Vance` }),
  );
  const online = new Set(room.map((p) => p.userId));

  function reveal(values: string[]) {
    return render(
      <Table
        seated={room}
        spectators={[]}
        online={online}
        votedUserIds={room.map((p) => p.userId)}
        votes={new Map(room.map((p, i) => [p.userId, values[i]]))}
        revealed
        consensus={new Set(values).size === 1}
        facilitatorId="ana"
        meId="ana"
      />,
    );
  }

  const flying = () =>
    Array.from(screen.getByTestId("pileon-layer").children, (c) => c.textContent);

  it("throws one emoji from every other seat at the lone dissenter", () => {
    reveal(["5", "5", "5", "5", "8"]);
    const thrown = flying();
    expect(thrown).toHaveLength(room.length - 1);
    for (const emoji of thrown) expect(PILE_ON_EMOJI).toContain(emoji);
  });

  it("stays out of the way of the consensus high-five", () => {
    reveal(["5", "5", "5", "5", "5"]);
    expect(flying()).toHaveLength(0);
    expect(screen.getAllByTestId("highfive-burst").length).toBeGreaterThan(0);
  });

  it("does not fire on a genuine split", () => {
    reveal(["5", "5", "5", "8", "13"]);
    expect(flying()).toHaveLength(0);
  });

  it("finds a dissenter whose id carries selector metacharacters", () => {
    const odd = [...room.slice(0, 4), makePerson({ userId: 'we"ird', name: "Odd Vance" })];
    render(
      <Table
        seated={odd}
        spectators={[]}
        online={new Set(odd.map((p) => p.userId))}
        votedUserIds={odd.map((p) => p.userId)}
        votes={new Map(odd.map((p, i) => [p.userId, i === 4 ? "8" : "5"]))}
        revealed
        consensus={false}
        facilitatorId="ana"
        meId="ana"
      />,
    );
    expect(flying()).toHaveLength(odd.length - 1);
  });

  it("creates no overlay children under reduced motion, and schedules no frames", () => {
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList);
    reveal(["5", "5", "5", "5", "8"]);
    expect(flying()).toHaveLength(0);
    expect(raf).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("cancels its cleanup timer and empties the overlay when the table unmounts", () => {
    const clear = vi.spyOn(window, "clearTimeout");
    const { unmount, container } = reveal(["5", "5", "5", "5", "8"]);
    const layer = screen.getByTestId("pileon-layer");
    expect(layer.children.length).toBeGreaterThan(0);
    unmount();
    expect(clear).toHaveBeenCalled();
    expect(layer.children).toHaveLength(0);
    expect(container.querySelector('[data-testid="pileon-layer"]')).toBeNull();
    vi.restoreAllMocks();
  });
});

/*
 * The drop-in. `css: false` in the Vitest config means no computed styles, but
 * `--drop-d` and the animation shorthand are inline on the seat, so both are
 * directly observable.
 */
describe("Table drop-in", () => {
  const three = ["dana", "marcus", "priya"];

  function joinable(over: Partial<Parameters<typeof Table>[0]> = {}) {
    const props = (presence: string[], extra: Partial<Parameters<typeof Table>[0]> = {}) => (
      <Table
        seated={[dana, marcus, priya]}
        spectators={[]}
        online={new Set(presence)}
        status="live"
        votedUserIds={[]}
        votes={new Map()}
        revealed={false}
        consensus={false}
        facilitatorId="dana"
        meId="dana"
        {...over}
        {...extra}
      />
    );
    const r = render(props(["dana", "marcus"]));
    return {
      ...r,
      arrive: (presence = three, extra = {}) => r.rerender(props(presence, extra)),
    };
  }

  const seatEl = (userId: string) =>
    document.querySelector(`[data-seat-user="${userId}"]`) as HTMLElement;

  it("animates nobody on the first envelope", () => {
    joinable();
    for (const id of ["dana", "marcus"]) expect(seatEl(id).style.animation).toBe("");
  });

  it("drops a mid-session joiner into their slot", () => {
    const { arrive } = joinable();
    arrive();
    const el = seatEl("priya");
    expect(el.style.animation).toContain("seat-drop");
    const d = Number(el.style.getPropertyValue("--drop-d").replace("px", ""));
    expect(d).toBeGreaterThan(70);
    expect(d).toBeLessThan(130);
    // The row is FLIPped open first, so the fall cannot start on frame zero.
    expect(el.style.animation).toMatch(/(\d+)ms both$/);
    expect(Number(el.style.animation.match(/ (\d+)ms both$/)![1])).toBeGreaterThanOrEqual(260);
    // Everyone already seated is left alone.
    expect(seatEl("dana").style.animation).toBe("");
  });

  // The room renders before the socket has registered you, so your own id
  // arrives in a later presence envelope — and used to fall into the seat you
  // were already sitting in, a second after the page settled.
  it("never drops the viewer into their own seat, joiner in the same burst or not", () => {
    const { arrive } = joinable({ meId: "dana" });
    // The first envelope has everyone but the viewer; the rebroadcast carries
    // the viewer's own registration and a genuine arrival together.
    arrive(["marcus"]);
    arrive(["marcus", "dana", "priya"]);
    expect(seatEl("dana").style.animation).toBe("");
    expect(seatEl("priya").style.animation).toContain("seat-drop");
  });

  it("holds the joiner's animation steady across later envelopes", () => {
    const { arrive } = joinable();
    arrive();
    const before = seatEl("priya").style.animation;
    arrive();
    arrive();
    expect(seatEl("priya").style.animation).toBe(before);
  });

  it("staggers a burst without queueing it", () => {
    const { arrive } = joinable();
    arrive();
    const delay = (id: string) => Number(seatEl(id).style.animation.match(/ (\d+)ms both$/)![1]);
    expect(delay("priya")).toBeGreaterThanOrEqual(260);
    expect(delay("priya")).toBeLessThanOrEqual(260 + 420);
  });

  it("schedules nothing at all under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const timer = vi.spyOn(globalThis, "setTimeout");
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    const { arrive } = joinable();
    arrive();
    expect(seatEl("priya").style.animation).toBe("");
    expect(timer).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
  });

  // The prune loop's comment claims the drop map "is bounded by the roster".
  // Churn a seat in and out and then bring it back on a frame that seeds
  // rather than diffs: with the pruning gone the stale entry survives the
  // absence and paints a fall nobody triggered, which is the same leak as an
  // unbounded map, made visible.
  it("forgets a drop once its seat leaves the roster", () => {
    const props = (seated: Parameters<typeof Table>[0]["seated"], presence: string[], status: "live" | "reconnecting" = "live") => (
      <Table
        seated={seated}
        spectators={[]}
        online={new Set(presence)}
        status={status}
        votedUserIds={[]}
        votes={new Map()}
        revealed={false}
        consensus={false}
        facilitatorId="dana"
        meId="dana"
      />
    );
    const pair = [dana, marcus];
    const trio = [dana, marcus, priya];
    const r = render(props(pair, ["dana", "marcus"]));
    for (let i = 0; i < 10; i++) {
      r.rerender(props(trio, ["dana", "marcus", "priya"]));
      expect(seatEl("priya").style.animation).toContain("seat-drop");
      r.rerender(props(pair, ["dana", "marcus"]));
    }
    // Back on a reconnect: nothing joined, so nothing may be falling.
    r.rerender(props(trio, ["dana", "marcus", "priya"], "reconnecting"));
    expect(seatEl("priya").style.animation).toBe("");
  });

  it("does not animate the room back in after a reconnect", () => {
    const { arrive } = joinable();
    arrive(["dana", "marcus"], { status: "reconnecting" as const });
    arrive(three, { status: "live" as const });
    for (const id of three) expect(seatEl(id).style.animation).toBe("");
  });
});

describe("the kick", () => {
  const seatedTrio = [dana, marcus, priya];

  /** Layout, which jsdom has none of: enough for the boot to have somewhere to swing. */
  function withLayout() {
    const rect = (el: Element): DOMRect => {
      const seat = el.closest?.("[data-seat-user]") as HTMLElement | null;
      const i = seat ? seatedTrio.findIndex((p) => p.userId === seat.dataset.seatUser) : -1;
      const left = 300 + Math.max(0, i) * 86;
      const box =
        el.hasAttribute?.("data-avatar") || el.querySelector?.("[data-avatar]") === null
          ? { left: left + 13, top: 210, width: 48, height: 48 }
          : { left, top: 200, width: 74, height: 150 };
      if ((el as HTMLElement).dataset?.testid === "kick-layer" || el === document.body) {
        return { left: 0, top: 100, width: 1280, height: 400, right: 1280, bottom: 500, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
      }
      return {
        ...box,
        right: box.left + box.width,
        bottom: box.top + box.height,
        x: box.left,
        y: box.top,
        toJSON: () => ({}),
      } as DOMRect;
    };
    return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      return rect(this);
    });
  }

  function kickable(over: Partial<Parameters<typeof Table>[0]> = {}) {
    const ui = (kicked: { userId: string; seq: number } | null) => (
      <Table
        seated={seatedTrio}
        spectators={[]}
        online={new Set(["dana", "marcus", "priya"])}
        votedUserIds={[]}
        votes={new Map()}
        revealed={false}
        consensus={false}
        facilitatorId="dana"
        meId="dana"
        kicked={kicked}
        {...over}
      />
    );
    const r = render(ui(null));
    return { ...r, boot: () => r.rerender(ui({ userId: "priya", seq: 1 })) };
  }

  const layer = () => screen.getByTestId("kick-layer");
  const seatOf = (id: string) => document.querySelector(`[data-seat-user="${id}"]`);

  it("offers a remove control on every seat but your own, only when it is given one", () => {
    render(
      <Table
        seated={seatedTrio}
        spectators={[]}
        online={new Set(["dana", "marcus", "priya"])}
        votedUserIds={[]}
        votes={new Map()}
        revealed={false}
        consensus={false}
        facilitatorId="dana"
        meId="dana"
        onRemove={() => {}}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Remove Dana Whitfield" })).toBeNull();
  });

  it("offers none at all without one", () => {
    kickable();
    expect(screen.queryAllByRole("button", { name: /^Remove / })).toHaveLength(0);
  });

  it("holds the seat in the row until the launch is off screen, then closes it", () => {
    vi.useFakeTimers();
    const rects = withLayout();
    try {
      const { boot } = kickable();
      boot();
      // The boot is beside the seat before anything moves, and it is the only
      // thing in the overlay until it connects.
      expect(layer().textContent).toContain("🥾");
      expect(seatOf("priya")).not.toBeNull();

      // Contact: the seat is cloned into the overlay and held, invisible, in
      // the row. The row must NOT have closed.
      act(() => vi.advanceTimersByTime(400));
      expect(layer().querySelector("[aria-hidden='true'] .truncate")).not.toBeNull();
      expect(seatOf("priya")).not.toBeNull();

      // And once it is gone, the row closes.
      act(() => vi.advanceTimersByTime(4000));
      expect(seatOf("priya")).toBeNull();
    } finally {
      rects.mockRestore();
      vi.useRealTimers();
    }
  });

  // Observed in a browser: the glyph held its last frame for the best part of
  // a second, because the overlay was only emptied once the SEAT had left.
  it("takes the boot out on its own schedule, while the seat is still flying", () => {
    vi.useFakeTimers();
    const rects = withLayout();
    try {
      const { boot } = kickable();
      boot();
      expect(layer().textContent).toContain("🥾");

      // Past the boot's own ending, but before the seat is gone.
      act(() => vi.advanceTimersByTime(720));
      expect(layer().textContent).not.toContain("🥾");
      // The seat's flight and the row's reflow are untouched by that.
      expect(layer().querySelector("[aria-hidden='true'] .truncate")).not.toBeNull();
      expect(seatOf("priya")).not.toBeNull();
    } finally {
      rects.mockRestore();
      vi.useRealTimers();
    }
  });

  it("leaves no stray glyph when there is no geometry to swing through", () => {
    // jsdom's own rects: every one of them zero, so the swing has no arc.
    vi.useFakeTimers();
    try {
      const { boot } = kickable();
      boot();
      expect(layer().childElementCount).toBe(0);
      // The row still closes — a removal nobody could animate is still a removal.
      expect(seatOf("priya")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the seat outright under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const rects = withLayout();
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    try {
      const { boot } = kickable();
      boot();
      expect(seatOf("priya")).toBeNull();
      expect(layer().childElementCount).toBe(0);
      expect(raf).not.toHaveBeenCalled();
    } finally {
      rects.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // Observed in a browser: the roster delta holds its last value while
  // nothing changes, so pruning the departed against `joined` put a seat that
  // had joined a moment earlier straight back into the row the instant it was
  // kicked.
  it("stays gone when the same person had only just joined", () => {
    const ui = (online: string[], kicked: { userId: string; seq: number } | null) => (
      <Table
        seated={seatedTrio}
        spectators={[]}
        online={new Set(online)}
        votedUserIds={[]}
        votes={new Map()}
        revealed={false}
        consensus={false}
        facilitatorId="dana"
        meId="dana"
        kicked={kicked}
      />
    );
    const r = render(ui(["dana", "marcus"], null));
    r.rerender(ui(["dana", "marcus", "priya"], null)); // priya arrives
    r.rerender(ui(["dana", "marcus", "priya"], { userId: "priya", seq: 1 }));
    expect(seatOf("priya")).toBeNull();
    // And a frame that changes nothing must not bring her back either.
    r.rerender(ui(["dana", "marcus"], { userId: "priya", seq: 1 }));
    expect(seatOf("priya")).toBeNull();
  });

  it("gives the seat back when they come around again", () => {
    const ui = (online: string[], kicked: { userId: string; seq: number } | null) => (
      <Table
        seated={seatedTrio}
        spectators={[]}
        online={new Set(online)}
        votedUserIds={[]}
        votes={new Map()}
        revealed={false}
        consensus={false}
        facilitatorId="dana"
        meId="dana"
        kicked={kicked}
      />
    );
    const r = render(ui(["dana", "marcus", "priya"], null));
    r.rerender(ui(["dana", "marcus", "priya"], { userId: "priya", seq: 1 }));
    expect(seatOf("priya")).toBeNull();
    r.rerender(ui(["dana", "marcus"], { userId: "priya", seq: 1 })); // presence catches up
    expect(seatOf("priya")).toBeNull();
    r.rerender(ui(["dana", "marcus", "priya"], { userId: "priya", seq: 1 })); // she walks back in
    expect(seatOf("priya")).not.toBeNull();
  });

  // Issue #462's last criterion: a removal arriving mid pile-on or mid drop-in
  // strands neither. Asserting the two overlay NODES differ never renders a
  // pile-on at all, so it cannot see stranding — these run one and watch it
  // survive a kick landing on somebody else's seat.
  // jsdom implements no WAAPI at all, so the adapter's feature detection makes
  // both animations no-op there. A stand-in gives the test something to watch:
  // whose animation was started, and whether anything cancelled it.
  function recordAnimations() {
    const seen: { el: Element; cancelled: boolean }[] = [];
    const proto = Element.prototype as unknown as { animate?: unknown };
    const had = "animate" in proto;
    const previous = proto.animate;
    proto.animate = function (this: Element) {
      const rec = { el: this, cancelled: false };
      seen.push(rec);
      return {
        cancel: () => {
          rec.cancelled = true;
        },
        finish: () => {},
      } as unknown as Animation;
    };
    const restore = () => {
      if (had) proto.animate = previous;
      else delete proto.animate;
    };
    return { seen, restore };
  }

  it("strands no pile-on that is already in flight", () => {
    vi.useFakeTimers();
    const rects = withLayout();
    const { seen, restore } = recordAnimations();
    try {
      // Priya is the lone dissenter, so the room throws at her seat. Four
      // voters, which is the fewest a pile-on fires for.
      const quartet = [...seatedTrio, makePerson({ userId: "quinn", name: "Quinn Alder" })];
      const ui = (kicked: { userId: string; seq: number } | null) => (
        <Table
          seated={quartet}
          spectators={[]}
          online={new Set(["dana", "marcus", "priya", "quinn"])}
          votedUserIds={["dana", "marcus", "priya", "quinn"]}
          votes={new Map([["dana", "5"], ["marcus", "5"], ["quinn", "5"], ["priya", "13"]])}
          revealed
          consensus={false}
          facilitatorId="dana"
          meId="dana"
          kicked={kicked}
        />
      );
      const r = render(ui(null));
      const pileon = screen.getByTestId("pileon-layer");
      const before = pileon.children.length;
      expect(before).toBeGreaterThan(0);
      const inFlight = seen.filter((a) => pileon.contains(a.el));
      expect(inFlight.length).toBe(before);

      // ...let the throw partially run, then remove somebody else mid-flight.
      act(() => vi.advanceTimersByTime(120));
      r.rerender(ui({ userId: "marcus", seq: 1 }));

      // The boot is in the air and the seat is still leaving, and the pile-on
      // holds exactly what it held: nothing of the kick's was added to it, and
      // nothing of its own was taken away or cancelled.
      act(() => vi.advanceTimersByTime(400));
      expect(pileon.children.length).toBe(before);
      expect(inFlight.filter((a) => a.cancelled)).toHaveLength(0);
      expect(inFlight.every((a) => pileon.contains(a.el))).toBe(true);
    } finally {
      restore();
      rects.mockRestore();
      vi.useRealTimers();
    }
  });

  it("strands no drop-in that is still falling", () => {
    vi.useFakeTimers();
    const rects = withLayout();
    const { seen, restore } = recordAnimations();
    try {
      const ui = (presence: string[], kicked: { userId: string; seq: number } | null) => (
        <Table
          seated={seatedTrio}
          spectators={[]}
          online={new Set(presence)}
          status="live"
          votedUserIds={[]}
          votes={new Map()}
          revealed={false}
          consensus={false}
          facilitatorId="dana"
          meId="dana"
          kicked={kicked}
        />
      );
      const r = render(ui(["dana", "marcus"], null));
      // Priya walks in and is still falling...
      r.rerender(ui(["dana", "marcus", "priya"], null));
      const falling = () => document.querySelector<HTMLElement>('[data-seat-user="priya"]')!;
      const drop = falling().style.animation;
      const distance = falling().style.getPropertyValue("--drop-d");
      expect(drop).toContain("seat-drop");
      expect(distance).not.toBe("");

      // ...when Marcus is removed out from under her.
      act(() => vi.advanceTimersByTime(60));
      r.rerender(ui(["dana", "marcus", "priya"], { userId: "marcus", seq: 1 }));
      act(() => vi.advanceTimersByTime(400));

      // Her fall is untouched: the same animation, from the same distance, not
      // restarted and not cancelled.
      expect(falling().style.animation).toBe(drop);
      expect(falling().style.getPropertyValue("--drop-d")).toBe(distance);
      expect(seen.filter((a) => a.el === falling() && a.cancelled)).toHaveLength(0);
    } finally {
      restore();
      rects.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the pile-on's overlay to itself", () => {
    // Two layers, not one: a kick landing mid-pile-on tears down its own
    // overlay when it is done, and must not empty the other's.
    kickable();
    expect(screen.getByTestId("pileon-layer")).not.toBe(screen.getByTestId("kick-layer"));
  });
});
