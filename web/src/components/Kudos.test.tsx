import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, makePerson } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { api, type Kudo } from "../lib/api";
import { Kudos, ago } from "./Kudos";

let kudos: Kudo[] = [];
/** The page after the first, answered to any request carrying a cursor. */
let older: Kudo[] = [];
/** When set, a first-page GET answers only once this settles, with the wall as it
    stood when the request was made — a refetch caught in flight. */
let hold: Promise<void> | null = null;
/** Kudos the server no longer has: withdrawn by their sender. Seen answers 404 for them. */
let withdrawn: string[] = [];
/** When set, the waiting read answers this instead of a list: a proxy error page, say. */
let waitingBody: unknown = undefined;
/** When set, the next answer PUT or DELETE fails with this status. */
let answerFail: number | null = null;
/** When set, an answer PUT or DELETE settles only once this does. */
let answerHold: Promise<void> | null = null;
/** When set, every read of the wall fails: the refetch after a write, say. */
let wallFails = false;

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path.endsWith("/kudos") && method === "GET") {
        if (wallFails) throw new actual.ApiError(503, "unavailable");
        const snapshot = kudos;
        if (hold) await hold;
        return snapshot;
      }
      // The caller's own unread kudos, from every page of the wall.
      if (path.endsWith("/kudos?waiting=1") && method === "GET") {
        if (waitingBody !== undefined) return waitingBody;
        const snapshot = [...kudos, ...older].filter((k) => k.toUserId === "marcus" && k.unread);
        if (hold) await hold;
        return snapshot;
      }
      if (path.includes("/kudos?before=") && method === "GET") return older;
      if (path.endsWith("/seen") && method === "POST") {
        if (withdrawn.some((id) => path.endsWith(`/kudos/${id}/seen`))) throw new actual.ApiError(404, "no such kudo");
        return undefined;
      }
      const answered = path.match(/\/kudos\/([^/]+)\/answer$/);
      if (answered && (method === "PUT" || method === "DELETE")) {
        if (answerHold) await answerHold;
        if (answerFail) {
          const status = answerFail;
          answerFail = null;
          throw new actual.ApiError(status, "could not save your answer");
        }
        // As the server does: a kudo its sender withdrew is a 404, and a
        // second answer is a 409 until the first is withdrawn.
        const k = kudos.find((x) => x.id === answered[1]);
        if (!k) throw new actual.ApiError(404, "no such kudo");
        if (method === "PUT" && k.answer) throw new actual.ApiError(409, "this kudo already has an answer; withdraw it first");
        const text = method === "PUT" ? (body as { text: string }).text : undefined;
        kudos = kudos.map((k) => (k.id === answered[1] ? { ...k, answer: text } : k));
        return undefined;
      }
      throw new Error(`unexpected api call: ${method} ${path}`);
    }),
  };
});

const members = [
  makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
  makePerson({ userId: "dana", name: "Dana Whitfield" }),
];

/** Opens the folded give form and returns the For what field. */
async function openForm() {
  await userEvent.click(await screen.findByRole("button", { name: "Thank someone" }));
  return screen.getByLabelText("For what");
}

function mount(over: Partial<Parameters<typeof Kudos>[0]> = {}) {
  return renderApp(
    <Kudos org="acme" slug="platform-team" members={members} meId="marcus" {...over} />,
  );
}

beforeEach(() => {
  vi.mocked(api).mockClear();
  kudos = [];
  older = [];
  hold = null;
  withdrawn = [];
  waitingBody = undefined;
  answerFail = null;
  answerHold = null;
  wallFails = false;
});

describe("Kudos wall", () => {
  it("treats a waiting read that is not a list as no letters, rather than crashing the wall", async () => {
    waitingBody = { error: "not a list" };
    mount();
    expect(await screen.findByTestId("kudos-empty")).toBeTruthy();
    expect(screen.queryByLabelText("A thank-you waiting for you")).toBe(null);
  });

  it("says something useful when nobody has been thanked yet", async () => {
    mount();
    expect(await screen.findByTestId("kudos-empty")).toBeTruthy();
    expect(screen.getByTestId("kudos-empty").textContent).toContain("No kudos yet");
  });

  it("renders a kudo whose sender and recipient have both left the space", async () => {
    kudos = [
      {
        id: "k1",
        fromUserId: "gone-1",
        toUserId: "gone-2",
        text: "Stayed late to unbreak the build.",
        createdAt: "2026-09-03T09:00:00.000Z",
        sessionId: "",
      },
    ];
    mount();
    const row = await screen.findByTestId("kudo-k1");
    expect(row.textContent).toContain("Stayed late to unbreak the build.");
    // A userId with nobody behind it must still read as somebody, not a blank.
    expect(row.textContent).toContain("Someone who has left");
    // Not yours, so there is nothing to withdraw.
    expect(within(row).queryByRole("button", { name: /withdraw/i })).toBe(null);
  });

  it("strips bidi formatting characters from a member's name on the wall", async () => {
    const bidiMembers = [
      makePerson({ userId: "marcus", name: "Marcus‮Okonjo" }),
      makePerson({ userId: "dana", name: "Dana Whitfield" }),
    ];
    kudos = [
      {
        id: "k3",
        fromUserId: "marcus",
        toUserId: "dana",
        text: "Covered the on-call swap.",
        createdAt: "2026-09-03T09:00:00.000Z",
        sessionId: "",
      },
    ];
    // Viewed by a third member, so Marcus is named rather than read back as "You".
    mount({ members: bidiMembers, meId: "sam" });
    const row = await screen.findByTestId("kudo-k3");
    expect(row.textContent).toContain("MarcusOkonjo");
    expect(row.textContent).not.toContain("‮");
  });

  it("strips bidi formatting characters from a member's name in the recipient picker", async () => {
    const bidiMembers = [
      makePerson({ userId: "marcus", name: "Marcus‮Okonjo" }),
      makePerson({ userId: "dana", name: "Dana Whitfield" }),
    ];
    mount({ members: bidiMembers, meId: "dana" });
    await openForm();
    const toSelect = screen.getByLabelText("To");
    expect(toSelect.textContent).toContain("MarcusOkonjo");
    expect(toSelect.textContent).not.toContain("‮");
  });

  it("lets long words and long names wrap rather than run off the panel", async () => {
    kudos = [
      {
        id: "k2",
        fromUserId: "marcus",
        toUserId: "dana",
        text: "Supercalifragilisticexpialidociousandthensomemoreletterstobesure",
        createdAt: "2026-09-03T09:00:00.000Z",
        sessionId: "",
      },
    ];
    mount({
      members: [
        ...members,
        makePerson({ userId: "dana", name: "Bartholomew Wolfeschlegelsteinhausenbergerdorff" }),
      ],
    });
    const row = await screen.findByTestId("kudo-k2");
    const text = within(row).getByTestId("kudo-text");
    // jsdom cannot measure, so the wrapping rule itself is what is pinned:
    // without break-words a single unbroken token overflows its container.
    expect(text.className).toContain("break-words");
    expect(within(row).getByTestId("kudo-who").className).toContain("break-words");
  });

  it("only offers people other than you as recipients", async () => {
    mount({ members: [...members, makePerson({ userId: "guest", name: "Link Guest", guest: true })] });
    await openForm();
    const picker = screen.getByLabelText("To");
    const names = within(picker).getAllByRole("option").map((o) => o.textContent);
    expect(names).toContain("Dana Whitfield");
    expect(names).not.toContain("Marcus Okonjo");
    // Guests neither send nor receive, so the picker never offers one.
    expect(names).not.toContain("Link Guest");
  });

  it("has no axe violations, a note addressed to the viewer included", async () => {
    kudos = [
      {
        id: "k4",
        fromUserId: "dana",
        toUserId: "marcus",
        text: "Held the line on the release.",
        createdAt: "2026-09-03T10:00:00.000Z",
        sessionId: "",
      },
      {
        id: "k3",
        fromUserId: "marcus",
        toUserId: "dana",
        text: "Caught the migration bug.",
        createdAt: "2026-09-03T09:00:00.000Z",
        sessionId: "",
      },
    ];
    const { container } = mount();
    await screen.findByTestId("kudo-k3");
    expect(within(screen.getByTestId("kudo-k4")).queryByTestId("kudo-note")).not.toBe(null);
    await expectNoViolations(container);
  });

  it("has no axe violations with the form open and the text over the limit", async () => {
    const { container } = mount();
    const field = await openForm();
    fireEvent.change(field, { target: { value: "a".repeat(290) } });
    await expectNoViolations(container);
  });

  it("keeps the counter out of sight until 40 characters are left", async () => {
    mount();
    const field = await openForm();
    await userEvent.type(field, "hello");
    // 275 left is nothing to warn about.
    expect(screen.queryByTestId("kudos-left")).toBe(null);
    fireEvent.change(field, { target: { value: "a".repeat(239) } });
    // Hand-written: 280 - 239 = 41, still quiet.
    expect(screen.queryByTestId("kudos-left")).toBe(null);
    fireEvent.change(field, { target: { value: "a".repeat(240) } });
    // Hand-written: 280 - 240.
    expect(screen.getByTestId("kudos-left").textContent).toContain("40");
  });

  it("counts an emoji as one rune, not the two UTF-16 units it occupies", async () => {
    mount();
    const field = await openForm();
    // Set directly: userEvent.type drives one keystroke per UTF-16 unit, which
    // mis-simulates a real emoji keystroke and is what would mask this bug.
    fireEvent.change(field, { target: { value: "🎉".repeat(250) } });
    // Hand-written: 280 - 250 runes. A UTF-16-length count would read -220.
    expect(screen.getByTestId("kudos-left").textContent).toContain("30");
  });

  it("disables submit only once the rune count, not the UTF-16 length, exceeds 280", async () => {
    mount();
    const field = await openForm();
    // A recipient is required too; select one so the count is the only thing
    // this assertion is pinning.
    await userEvent.selectOptions(screen.getByLabelText("To"), "dana");
    // 280 emoji is exactly 280 runes but 560 UTF-16 units, so a UTF-16-length
    // count would already have refused this as over the limit.
    fireEvent.change(field, { target: { value: "🎉".repeat(280) } });
    expect(screen.getByTestId("kudos-left").textContent).toContain("0");
    expect(screen.getByRole("button", { name: "Give kudos" }).hasAttribute("disabled")).toBe(false);
  });

  it("says why Give kudos is refused once the text runs over, and announces it once", async () => {
    mount();
    const field = await openForm();
    await userEvent.selectOptions(screen.getByLabelText("To"), "dana");
    const alert = screen.getByTestId("kudos-over");
    expect(alert.getAttribute("aria-live")).toBe("polite");
    expect(alert.textContent).toBe("");
    fireEvent.change(field, { target: { value: "a".repeat(283) } });
    expect(screen.getByRole("button", { name: "Give kudos" }).hasAttribute("disabled")).toBe(true);
    // Hand-written: 283 - 280.
    expect(screen.getByTestId("kudos-left").textContent).toContain("3 over");
    expect(alert.textContent).toMatch(/280 characters/);
  });

  it("tells two members with the same name apart in the picker", async () => {
    mount({
      members: [
        ...members,
        makePerson({ userId: "u-7f3a", name: "Kade" }),
        makePerson({ userId: "u-91c2", name: "Kade" }),
      ],
    });
    await openForm();
    const names = within(screen.getByLabelText("To"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names).toEqual(["Choose somebody", "Dana Whitfield", "Kade · 7f3a", "Kade · 91c2"]);
  });

  it("shows the five newest and folds the rest behind Show all", async () => {
    kudos = Array.from({ length: 7 }, (_, i) => ({
      id: `n${i}`,
      fromUserId: "dana",
      toUserId: "gone",
      text: `Kudo number ${i}`,
      createdAt: "2026-09-03T09:00:00.000Z",
      sessionId: "",
    }));
    mount();
    await screen.findByTestId("kudo-n0");
    expect(screen.queryByTestId("kudo-n5")).toBe(null);
    const more = screen.getByRole("button", { name: /^Show all/ });
    // Nothing here is counted: not even the wall's length on the way to it.
    expect(more.textContent).not.toMatch(/\d/);
    expect(more.getAttribute("aria-label") ?? "").not.toMatch(/\d/);
    await userEvent.click(more);
    expect(screen.getByTestId("kudo-n6")).toBeTruthy();
    const fewer = screen.getByRole("button", { name: "Show fewer" });
    expect(fewer.textContent).not.toMatch(/\d/);
    await userEvent.click(fewer);
    expect(screen.queryByTestId("kudo-n5")).toBe(null);
  });
});

describe("Kudos wall, addressed to the viewer", () => {
  const kudo = (id: string, fromUserId: string, toUserId: string): Kudo => ({
    id,
    fromUserId,
    toUserId,
    text: `Kudo ${id}`,
    createdAt: "2026-09-03T09:00:00.000Z",
    sessionId: "",
  });
  const people = [
    ...members,
    makePerson({ userId: "sam", name: "Sam Ortiz" }),
  ];

  it("says \"thanked you\" and marks a kudo to the viewer", async () => {
    kudos = [kudo("k1", "dana", "marcus")];
    mount({ members: people });
    const row = await screen.findByTestId("kudo-k1");
    expect(within(row).getByTestId("kudo-who").textContent).toBe("Dana Whitfield thanked you");
    expect(row.getAttribute("data-to-me")).toBe("true");
    // Handed to you: the words sit on a note, signed by who sent it. The
    // sign-off repeats the name the line above already says, so it is hidden
    // from a screen reader rather than read twice.
    const note = within(row).getByTestId("kudo-note");
    expect(within(note).getByTestId("kudo-text").textContent).toBe("Kudo k1");
    const sign = within(note).getByTestId("kudo-sign");
    expect(sign.textContent).toBe("— Dana Whitfield");
    expect(sign.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws the sender's own avatar on the note, same as an ordinary row", async () => {
    kudos = [
      kudo("k1", "dana", "marcus"),
      kudo("k2", "dana", "sam"),
    ];
    mount({
      members: [
        makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
        makePerson({ userId: "dana", name: "Dana Whitfield", avatarIcon: "ada" }),
        makePerson({ userId: "sam", name: "Sam Ortiz" }),
      ],
    });
    const noteRow = await screen.findByTestId("kudo-k1");
    const ordinaryRow = await screen.findByTestId("kudo-k2");
    // Both rows are Dana's; an ordinary row draws her chosen portrait, so the
    // note addressed to you must too rather than falling back to initials.
    const noteImg = noteRow.querySelector("img");
    const ordinaryImg = ordinaryRow.querySelector("img");
    expect(ordinaryImg?.getAttribute("src")).toContain("ada");
    expect(noteImg?.getAttribute("src")).toBe(ordinaryImg?.getAttribute("src"));
  });

  it("says \"You thanked\" on the viewer's own kudo, unmarked", async () => {
    kudos = [kudo("k1", "marcus", "sam")];
    mount({ members: people });
    const row = await screen.findByTestId("kudo-k1");
    expect(within(row).getByTestId("kudo-who").textContent).toBe("You thanked Sam Ortiz");
    expect(row.getAttribute("data-to-me")).toBe(null);
    expect(row.querySelector("[data-testid=kudo-note]")).toBe(null);
    expect(row.querySelector("[data-testid=kudo-sign]")).toBe(null);
  });

  it("names both people on a kudo the viewer is not in", async () => {
    kudos = [kudo("k1", "dana", "sam")];
    mount({ members: people });
    const row = await screen.findByTestId("kudo-k1");
    expect(within(row).getByTestId("kudo-who").textContent).toBe("Dana Whitfield thanked Sam Ortiz");
    expect(row.getAttribute("data-to-me")).toBe(null);
    expect(row.querySelector("[data-testid=kudo-note]")).toBe(null);
    expect(row.querySelector("[data-testid=kudo-sign]")).toBe(null);
  });

  it("never folds a kudo addressed to the viewer behind Show all", async () => {
    kudos = [
      ...Array.from({ length: 6 }, (_, i) => kudo(`n${i}`, "dana", "sam")),
      kudo("mine", "dana", "marcus"),
    ];
    mount({ members: people });
    expect(await screen.findByTestId("kudo-mine")).toBeTruthy();
    expect(screen.queryByTestId("kudo-n5")).toBe(null);
    expect(screen.getByRole("button", { name: "Show all" })).toBeTruthy();
  });

  it("offers no Show all when every kudo past the fold is addressed to the viewer", async () => {
    kudos = [
      ...Array.from({ length: 5 }, (_, i) => kudo(`n${i}`, "dana", "sam")),
      kudo("mine1", "dana", "marcus"),
      kudo("mine2", "sam", "marcus"),
    ];
    mount({ members: people });
    expect(await screen.findByTestId("kudo-mine2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show all" })).toBe(null);
  });
});

describe("Kudos wall paging", () => {
  const page = (n: number, prefix: string, at: string) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}${i}`,
      fromUserId: "dana",
      toUserId: "gone",
      text: `Kudo ${prefix}${i}`,
      createdAt: at,
      sessionId: "",
    }));

  it("offers Show older only when a page came back full, and appends it", async () => {
    // Microseconds on purpose: the cursor must be the server's string verbatim.
    kudos = page(100, "a", "2026-09-03T09:00:00.123456Z");
    older = page(3, "b", "2026-09-01T09:00:00Z");
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Show all" }));
    const olderBtn = screen.getByRole("button", { name: "Show older" });
    await userEvent.click(olderBtn);
    expect(await screen.findByTestId("kudo-b2")).toBeTruthy();
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      "GET",
      "/api/orgs/acme/spaces/platform-team/kudos?before=2026-09-03T09%3A00%3A00.123456Z&beforeId=a99",
    );
    // The second page was short: that is the end of the wall.
    expect(screen.queryByRole("button", { name: "Show older" })).toBe(null);
  });

  it("still offers Show older when nothing on the first page is folded away", async () => {
    kudos = [
      ...page(5, "a", "2026-09-03T09:00:00Z"),
      ...page(95, "m", "2026-09-03T08:00:00Z").map((k) => ({ ...k, toUserId: "marcus" })),
    ];
    older = page(3, "b", "2026-09-01T09:00:00Z");
    mount();
    await screen.findByTestId("kudo-m94");
    expect(screen.queryByRole("button", { name: "Show all" })).toBe(null);
    await userEvent.click(screen.getByRole("button", { name: "Show older" }));
    expect(await screen.findByTestId("kudo-b0")).toBeTruthy();
  });

  it("does not offer Show older when the first page is short", async () => {
    kudos = page(99, "a", "2026-09-03T09:00:00Z");
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Show all" }));
    expect(screen.queryByRole("button", { name: "Show older" })).toBe(null);
  });
});

/** Records every animation started, and finishes them all at once on demand. */
function recordAnimations() {
  const calls: { el: Element; frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  const original = Element.prototype.animate;
  Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    calls.push({ el: this, frames: frames as Keyframe[], options: options as KeyframeAnimationOptions });
    return { finished, cancel: () => {} } as unknown as Animation;
  };
  return { calls, finish: () => finish(), restore: () => void (Element.prototype.animate = original) };
}

/** jsdom has no layout: puts each named row at a top, and everything else near the top of a 768px window. */
function placeRows(tops: Record<string, number>) {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const row = this.closest?.('li[data-testid^="kudo-"]');
    const top = row ? (tops[row.getAttribute("data-testid")!.slice(5)] ?? 600) : 120;
    return { top, bottom: top + 90, left: 20, right: 300, width: 280, height: 90, x: 20, y: top, toJSON: () => ({}) } as DOMRect;
  };
  return { restore: () => void (Element.prototype.getBoundingClientRect = original) };
}

describe("Kudos letter", () => {
  const putName = /^Put it with the others, Dana Whitfield's thank-you$/;
  const letter = (id: string, over: Partial<Kudo> = {}): Kudo => ({
    id,
    fromUserId: "dana",
    toUserId: "marcus",
    text: `Thanks for ${id}.`,
    createdAt: "2026-09-03T09:00:00.000Z",
    sessionId: "",
    unread: true,
    ...over,
  });

  it("leaves an unread kudo to you as a signed letter above the list, not twice", async () => {
    kudos = [letter("k1"), letter("k2", { unread: false, text: "Old thanks." })];
    mount();
    const card = await screen.findByTestId("kudo-letter");
    expect(within(card).getByTestId("kudo-note").textContent).toContain("Thanks for k1.");
    expect(within(card).getByTestId("kudo-sign").textContent).toContain("Dana Whitfield");
    expect(card.outerHTML).toContain("note-set-down");
    expect(screen.queryByTestId("kudo-k1")).toBe(null);
    expect(screen.getByTestId("kudo-k2")).toBeTruthy();
    // One letter waiting: no stacked edge.
    expect(screen.queryByTestId("kudo-letter-stack")).toBe(null);
    expect(screen.queryByRole("dialog")).toBe(null);
  });

  it("shows no letter for a kudo that is read or not addressed to you", async () => {
    kudos = [letter("k1", { unread: false }), letter("k2", { toUserId: "dana", fromUserId: "marcus" })];
    mount();
    await screen.findByTestId("kudo-k1");
    expect(screen.queryByTestId("kudo-letter")).toBe(null);
  });

  it("puts the letter with the others: calls seen, and it sets down into the list", async () => {
    kudos = [letter("k1")];
    mount();
    await userEvent.click(await screen.findByRole("button", { name: putName }));
    expect(api).toHaveBeenCalledWith("POST", "/api/orgs/acme/spaces/platform-team/kudos/k1/seen");
    const row = await screen.findByTestId("kudo-k1");
    expect(row.hasAttribute("data-to-me")).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(screen.queryByTestId("kudo-letter")).toBe(null);
  });

  it("is a labelled group, and says without a number that another is waiting", async () => {
    kudos = [letter("k1")];
    const { unmount } = mount();
    const one = await screen.findByRole("group", { name: "A thank-you waiting for you" });
    expect(one.getAttribute("aria-describedby")).toBe(null);
    unmount();

    kudos = [letter("k1"), letter("k2")];
    mount();
    const two = await screen.findByRole("group", { name: "A thank-you waiting for you" });
    const describedBy = two.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!)!;
    expect(description.textContent).toBe("Another is waiting after this one.");
    // Said once, as the group's description, and never read again as content.
    expect(description.hidden).toBe(true);
    expect(within(two).getByText("Waiting for you")).toBeTruthy();
  });

  it("names whose thank-you the button puts away, and keeps the visible words first", async () => {
    kudos = [letter("k1")];
    mount();
    const button = await screen.findByRole("button", { name: putName });
    // One name, spelled out, rather than visible words and a hidden tail that a
    // browser joins as "others , Dana".
    expect(button.getAttribute("aria-label")).toBe("Put it with the others, Dana Whitfield's thank-you");
    expect(button.textContent).toBe("Put it with the others");
  });

  it("keeps the edge behind the note alone, never behind the button", async () => {
    kudos = [letter("k1"), letter("k2")];
    mount();
    const stack = await screen.findByTestId("kudo-letter-stack");
    const box = stack.parentElement!;
    expect(within(box).getByTestId("kudo-note")).toBeTruthy();
    expect(within(box).queryByRole("button")).toBe(null);
    // It falls with the note, so no frame shows the edge without its letter.
    expect(box.className).toContain("*:animate-[note-set-down");
  });

  it("moves focus to the next letter's button when another is waiting", async () => {
    kudos = [letter("k1"), letter("k2", { text: "Second thanks." })];
    mount();
    await userEvent.click(await screen.findByRole("button", { name: putName }));
    await screen.findByTestId("kudo-k1");
    const next = await screen.findByRole("group", { name: "A thank-you waiting for you" });
    expect(within(next).getByTestId("kudo-text").textContent).toBe("Second thanks.");
    expect(document.activeElement).toBe(within(next).getByRole("button", { name: putName }));
  });

  it("keeps the label and the button still, with the next letter there at once", async () => {
    const anim = recordAnimations();
    try {
      kudos = [letter("k1"), letter("k2", { text: "Second thanks.", createdAt: "2026-09-03T08:00:00.000Z" })];
      mount();
      const button = await screen.findByRole("button", { name: putName });
      const label = screen.getByText("Waiting for you");
      await waitFor(() => expect(button.hasAttribute("inert")).toBe(false), { timeout: 1500 });
      await userEvent.click(button);
      await screen.findByTestId("kudo-k1");
      // Mid-move: the note is on its way, and the next letter is already under it.
      const group = screen.getByRole("group", { name: "A thank-you waiting for you" });
      expect(within(group).getByTestId("kudo-text").textContent).toBe("Second thanks.");
      expect(screen.getByRole("button", { name: putName })).toBe(button);
      expect(screen.getByText("Waiting for you")).toBe(label);
      expect(button.closest("[inert], [aria-hidden=true]")).toBe(null);
      // Focus never leaves the button it was on, so it is never on the body.
      expect(document.activeElement).toBe(button);
      // Nothing that stays is faded out and back.
      const faded = anim.calls.filter((c) => (c.el === button || c.el === label) && JSON.stringify(c.frames).includes("opacity"));
      expect(faded).toHaveLength(0);
    } finally {
      anim.restore();
    }
  });

  it("moves focus to the row before the last letter's note sets off", async () => {
    const anim = recordAnimations();
    try {
      kudos = [letter("k1")];
      mount();
      await userEvent.click(await screen.findByRole("button", { name: putName }));
      const row = await screen.findByTestId("kudo-k1");
      // Still moving: the letter is on its way out, and focus is already home.
      expect(screen.getByTestId("kudo-letter-block")).toBeTruthy();
      expect(document.activeElement).toBe(row);
    } finally {
      anim.restore();
    }
  });

  it("keeps the letter being read when a newer one arrives, and only says another is waiting", async () => {
    kudos = [letter("k1", { text: "First thanks." })];
    const { queryClient } = mount();
    const note = within(await screen.findByTestId("kudo-letter")).getByTestId("kudo-note");
    kudos = [letter("k2", { text: "Newer thanks.", createdAt: "2026-09-03T10:00:00.000Z" }), ...kudos];
    await queryClient.invalidateQueries({ queryKey: ["kudos", "acme", "platform-team"] });
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "A thank-you waiting for you" }).getAttribute("aria-describedby")).toBeTruthy(),
    );
    const card = screen.getByTestId("kudo-letter");
    expect(within(card).getByTestId("kudo-text").textContent).toBe("First thanks.");
    expect(within(card).getByTestId("kudo-note")).toBe(note);
    // Nor is the newer one drawn in the list meanwhile: it is the next letter.
    expect(screen.queryByText("Newer thanks.")).toBe(null);
  });

  it("holds a letter that arrives mid-move until the note has come to rest", async () => {
    const anim = recordAnimations();
    try {
      kudos = [
        letter("k1", { createdAt: "2026-09-03T10:00:00.000Z" }),
        letter("k2", { text: "Second thanks.", createdAt: "2026-09-03T09:00:00.000Z" }),
      ];
      const { queryClient } = mount();
      await userEvent.click(await screen.findByRole("button", { name: putName }));
      await screen.findByTestId("kudo-k1");
      kudos = [letter("k3", { text: "Live thanks.", createdAt: "2026-09-03T11:00:00.000Z" }), ...kudos];
      await queryClient.invalidateQueries({ queryKey: ["kudos", "acme", "platform-team"] });
      await new Promise((r) => setTimeout(r, 20));
      // Nothing of it is drawn while the note is moving: not a letter, not a row.
      expect(screen.queryByText("Live thanks.")).toBe(null);
      expect(screen.getByRole("group", { name: "A thank-you waiting for you" }).getAttribute("aria-describedby")).toBe(null);
      anim.finish();
      // Once it has settled the arrival only says another is waiting; the
      // letter on show stays the one that was already there.
      await waitFor(() =>
        expect(screen.getByRole("group", { name: "A thank-you waiting for you" }).getAttribute("aria-describedby")).toBeTruthy(),
      );
      expect(within(screen.getByTestId("kudo-letter")).getByTestId("kudo-text").textContent).toBe("Second thanks.");
      expect(screen.queryByText("Live thanks.")).toBe(null);
    } finally {
      anim.restore();
    }
  });

  it("sets a note down in place, with no slide and no scroll, when its row is off screen", async () => {
    const anim = recordAnimations();
    const rects = placeRows({ k1: 5000 });
    const scroll = vi.fn();
    const originalScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      kudos = [letter("k1")];
      mount();
      await userEvent.click(await screen.findByRole("button", { name: putName }));
      await screen.findByTestId("kudo-k1");
      expect(anim.calls.length).toBeGreaterThan(0);
      expect(anim.calls.filter((c) => JSON.stringify(c.frames).includes("translate("))).toHaveLength(0);
      anim.finish();
      await waitFor(() => expect(screen.queryByTestId("kudo-letter-block")).toBe(null));
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
      rects.restore();
      anim.restore();
    }
  });

  it("slides a note to a row on screen, pushed off gently before friction slows it", async () => {
    const anim = recordAnimations();
    const rects = placeRows({ k1: 420 });
    try {
      kudos = [letter("k1")];
      mount();
      await userEvent.click(await screen.findByRole("button", { name: putName }));
      await screen.findByTestId("kudo-k1");
      const slide = anim.calls.find((c) => c.el.getAttribute("data-testid") === "kudo-note" && JSON.stringify(c.frames).includes("translate("));
      expect(slide).toBeTruthy();
      const [first, push] = slide!.frames;
      // From rest: an ease-in whose opening slope is zero, never full speed on frame one.
      expect(first.easing).toBe("cubic-bezier(0.333, 0, 0.667, 0.333)");
      // Hand-written: the push lasts 80-100ms of the slide, then friction.
      const pushMs = (push.offset as number) * (slide!.options.duration as number);
      expect(pushMs).toBeGreaterThanOrEqual(80);
      expect(pushMs).toBeLessThanOrEqual(100);
      expect(push.easing).toBe("cubic-bezier(0.333, 0.667, 0.667, 1)");
    } finally {
      rects.restore();
      anim.restore();
    }
  });

  it("keeps the button out of reach until its pill can be seen", async () => {
    kudos = [letter("k1")];
    mount();
    const button = (await screen.findByText("Put it with the others")).closest("button")!;
    expect(button.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(button.hasAttribute("inert")).toBe(false), { timeout: 1500 });
  });

  it("gives the full treatment to the waiting letter alone, not to the ones already read", async () => {
    kudos = [letter("k1"), letter("k2", { unread: false, text: "Old thanks." })];
    mount();
    const row = await screen.findByTestId("kudo-k2");
    expect(row.getAttribute("data-to-me")).toBe("true");
    expect(row.className).not.toMatch(/bg-accent-soft|border-pip/);
    const edge = screen.getByTestId("kudo-letter").parentElement!;
    expect(edge.className).toMatch(/border-pip/);
    expect(edge.className).toMatch(/bg-accent-soft/);
  });

  it("does not put the next letter away on a second press that comes before it has been seen", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") || query.includes("min-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
    kudos = [letter("k1"), letter("k2", { text: "Second thanks.", createdAt: "2026-09-03T08:00:00.000Z" })];
    mount();
    const button = await screen.findByRole("button", { name: putName });
    await userEvent.dblClick(button);
    await screen.findByTestId("kudo-k1");
    await new Promise((r) => setTimeout(r, 20));
    const seens = vi.mocked(api).mock.calls.filter((c) => c[0] === "POST" && String(c[1]).endsWith("/seen"));
    expect(seens).toHaveLength(1);
    expect(within(screen.getByTestId("kudo-letter")).getByTestId("kudo-text").textContent).toBe("Second thanks.");
  });

  it("does not land a letter again when the server still says unread after it was put away", async () => {
    kudos = [letter("k1")];
    const { queryClient } = mount();
    await userEvent.click(await screen.findByRole("button", { name: putName }));
    await screen.findByTestId("kudo-k1");
    // The mock's seen never touches `kudos`: every refetch from here is a
    // server that has not recorded the put-away yet, and still says unread.
    await queryClient.invalidateQueries({ queryKey: ["kudos", "acme", "platform-team"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("kudo-letter")).toBe(null);
    expect(screen.getByTestId("kudo-k1")).toBeTruthy();
  });

  it("leaves a letter for an unread kudo older than the wall's first page, and never draws it twice", async () => {
    kudos = Array.from({ length: 100 }, (_, i) => ({
      id: `a${i}`,
      fromUserId: "dana",
      toUserId: "gone",
      text: `Kudo a${i}`,
      createdAt: "2026-09-03T09:00:00.000Z",
      sessionId: "",
    }));
    older = [letter("deep", { text: "From a while back.", createdAt: "2026-08-01T09:00:00.000Z" })];
    mount();
    const card = await screen.findByTestId("kudo-letter");
    expect(within(card).getByTestId("kudo-text").textContent).toBe("From a while back.");
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    await userEvent.click(screen.getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("GET", expect.stringContaining("?before=")));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("kudo-deep")).toBe(null);
    expect(screen.getAllByText("From a while back.")).toHaveLength(1);
  });

  it("opens room for a letter that arrives after the wall is drawn, and not for one there on first paint", async () => {
    const heights: string[] = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null) {
      if (this.getAttribute("data-testid") === "kudo-letter-block") heights.push(JSON.stringify(frames));
      return { finished: Promise.resolve(), cancel: () => {} } as unknown as Animation;
    };
    try {
      kudos = [letter("k1", { unread: false })];
      const { queryClient } = mount();
      await screen.findByTestId("kudo-k1");
      kudos = [letter("k2", { text: "Live thanks." }), ...kudos];
      await queryClient.invalidateQueries({ queryKey: ["kudos", "acme", "platform-team"] });
      await screen.findByTestId("kudo-letter");
      expect(heights).toHaveLength(1);
      expect(heights[0]).toContain('"height":"0px"');
    } finally {
      Element.prototype.animate = original;
    }
    heights.length = 0;
    cleanup();
    kudos = [letter("k3")];
    mount();
    await screen.findByTestId("kudo-letter");
    expect(heights).toHaveLength(0);
  });

  it("swaps at once under reduced motion, with nothing animated", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") || query.includes("min-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
    const animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel: () => {} }) as unknown as Animation);
    const original = Element.prototype.animate;
    Element.prototype.animate = animate;
    try {
      kudos = [letter("k1"), letter("k2", { text: "Second thanks." })];
      mount();
      await userEvent.click(await screen.findByRole("button", { name: putName }));
      const next = await screen.findByRole("group", { name: "A thank-you waiting for you" });
      expect(within(next).getByTestId("kudo-text").textContent).toBe("Second thanks.");
      expect(screen.getByTestId("kudo-k1")).toBeTruthy();
      expect(animate).not.toHaveBeenCalled();
    } finally {
      Element.prototype.animate = original;
    }
  });

  it("does not land the letter again when a refetch in flight answers after it was put away", async () => {
    kudos = [letter("k1")];
    const { queryClient } = mount();
    await screen.findByTestId("kudo-letter");
    // A focus refetch leaves while the letter is still unread, and is held.
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    void queryClient.refetchQueries({ queryKey: ["kudos", "acme", "platform-team"] });
    await userEvent.click(screen.getByRole("button", { name: putName }));
    await screen.findByTestId("kudo-k1");
    // The stale answer, still saying unread, arrives after the put-away.
    release();
    hold = null;
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("kudo-letter")).toBe(null);
    const cached = queryClient.getQueryData<{ pages: Kudo[][] }>(["kudos", "acme", "platform-team"]);
    expect(cached!.pages[0].find((k) => k.id === "k1")!.unread).toBe(false);
  });

  it("does not land the letter again when the wall refetches", async () => {
    kudos = [letter("k1")];
    const { queryClient } = mount();
    const first = await screen.findByTestId("kudo-letter");
    await queryClient.invalidateQueries({ queryKey: ["kudos", "acme", "platform-team"] });
    await screen.findByTestId("kudo-letter");
    expect(screen.getByTestId("kudo-letter")).toBe(first);
  });

  it("draws one fixed edge behind the letter whatever the number waiting, and no number", async () => {
    const seenAs: string[] = [];
    for (const n of [2, 30]) {
      kudos = Array.from({ length: n }, (_, i) => letter(`k${i}`));
      const { unmount } = mount();
      const stack = await screen.findByTestId("kudo-letter-stack");
      expect(stack.getAttribute("aria-hidden")).toBe("true");
      expect(stack.textContent).toBe("");
      expect(screen.getAllByTestId("kudo-letter-stack")).toHaveLength(1);
      seenAs.push(
        screen.getByRole("group", { name: "A thank-you waiting for you" }).outerHTML.replace(/_r_[^"]*_/g, "id"),
      );
      unmount();
    }
    // Two waiting and thirty waiting render identically.
    expect(seenAs[0]).toBe(seenAs[1]);
  });

  it("never changes which other kudos are shown when a letter is put away", async () => {
    // The letter is the newest; five others fill the fold exactly. Putting the
    // letter away adds a row addressed to you, which is never folded, so it
    // must not push the fifth of the others behind Show all.
    kudos = [
      letter("k1", { createdAt: "2026-09-03T10:00:00.000Z" }),
      ...Array.from({ length: 5 }, (_, i) => letter(`o${i}`, { toUserId: "sam", unread: undefined })),
    ];
    mount();
    await screen.findByTestId("kudo-o4");
    expect(screen.queryByRole("button", { name: "Show all" })).toBe(null);
    await userEvent.click(await screen.findByRole("button", { name: putName }));
    await screen.findByTestId("kudo-k1");
    for (let i = 0; i < 5; i++) expect(screen.getByTestId(`kudo-o${i}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show all" })).toBe(null);
  });

  it("sets a letter withdrawn while it is shown down in place, and focus goes to the heading", async () => {
    const anim = recordAnimations();
    try {
      kudos = [letter("k1")];
      const { queryClient } = mount();
      const button = await screen.findByRole("button", { name: putName });
      await waitFor(() => expect(button.hasAttribute("inert")).toBe(false), { timeout: 1500 });
      button.focus();
      // The sender withdraws it; the next refetch no longer has it.
      kudos = [];
      await queryClient.invalidateQueries({ queryKey: ["kudos", "acme", "platform-team"] });
      await new Promise((r) => setTimeout(r, 20));
      // Not unmounted in one frame: it closes up softly where it is.
      const block = screen.getByTestId("kudo-letter-block");
      expect(anim.calls.some((c) => c.el === block && JSON.stringify(c.frames).includes("height"))).toBe(true);
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Kudos" }));
      anim.finish();
      await waitFor(() => expect(screen.queryByTestId("kudo-letter-block")).toBe(null));
      expect(screen.queryByTestId("kudo-k1")).toBe(null);
      expect(document.activeElement).not.toBe(document.body);
    } finally {
      anim.restore();
    }
  });

  it("keeps focus on the page when the shown letter is read elsewhere", async () => {
    const anim = recordAnimations();
    try {
      kudos = [letter("k1")];
      const { queryClient } = mount();
      const button = await screen.findByRole("button", { name: putName });
      await waitFor(() => expect(button.hasAttribute("inert")).toBe(false), { timeout: 1500 });
      button.focus();
      // Read in another tab: the wall already shows it as read, so the
      // waiting query (filtered by unread) drops it without ever going
      // through this tab's own putAway.
      kudos = [letter("k1", { unread: false })];
      await queryClient.invalidateQueries({ queryKey: ["kudos", "acme", "platform-team"] });
      await new Promise((r) => setTimeout(r, 20));
      expect(document.activeElement).not.toBe(document.body);
      anim.finish();
      await waitFor(() => expect(screen.queryByTestId("kudo-letter-block")).toBe(null));
      expect(document.activeElement).not.toBe(document.body);
    } finally {
      anim.restore();
    }
  });

  it("slides a withdrawn letter off the pile when another is waiting, focus staying on the button", async () => {
    const anim = recordAnimations();
    try {
      kudos = [letter("k1"), letter("k2", { text: "Second thanks.", createdAt: "2026-09-03T08:00:00.000Z" })];
      const { queryClient } = mount();
      const button = await screen.findByRole("button", { name: putName });
      await waitFor(() => expect(button.hasAttribute("inert")).toBe(false), { timeout: 1500 });
      button.focus();
      kudos = kudos.filter((k) => k.id !== "k1");
      await queryClient.invalidateQueries({ queryKey: ["kudos", "acme", "platform-team"] });
      await new Promise((r) => setTimeout(r, 20));
      expect(within(screen.getByTestId("kudo-letter")).getByTestId("kudo-text").textContent).toBe("Second thanks.");
      // The withdrawn note is a copy lifted off the top of the pile, not a swap.
      expect(anim.calls.some((c) => c.el.textContent?.includes("Thanks for k1.") && JSON.stringify(c.frames).includes("translateY"))).toBe(true);
      expect(document.activeElement).toBe(button);
    } finally {
      anim.restore();
    }
  });

  it("puts a letter away quietly when the server says it no longer exists", async () => {
    kudos = [letter("k1")];
    withdrawn = ["k1"];
    mount();
    await userEvent.click(await screen.findByRole("button", { name: putName }));
    await waitFor(() => expect(screen.queryByTestId("kudo-letter-block")).toBe(null));
    // No error for a kudo that is simply gone, and no row for it either.
    expect(screen.queryByText(/no such kudo/)).toBe(null);
    expect(screen.queryByTestId("kudo-k1")).toBe(null);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Kudos" }));
  });

  it("puts one letter away, not two, when Enter is held down", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion") || query.includes("min-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
    kudos = [
      letter("k1"),
      letter("k2", { text: "Second thanks.", createdAt: "2026-09-03T08:00:00.000Z" }),
      letter("k3", { text: "Third thanks.", createdAt: "2026-09-03T07:00:00.000Z" }),
    ];
    mount();
    const button = await screen.findByRole("button", { name: putName });
    button.focus();
    // The first keydown, then the key's own auto-repeat long after the lock has lapsed.
    await userEvent.keyboard("{Enter>}");
    await screen.findByTestId("kudo-k1");
    await new Promise((r) => setTimeout(r, 600));
    const repeat = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", repeat: true, bubbles: true, cancelable: true });
    button.dispatchEvent(repeat);
    // A browser activates a button on an uncancelled Enter keydown; a repeat must be cancelled.
    expect(repeat.defaultPrevented).toBe(true);
    await userEvent.keyboard("{/Enter}");
    const seens = vi.mocked(api).mock.calls.filter((c) => c[0] === "POST" && String(c[1]).endsWith("/seen"));
    expect(seens).toHaveLength(1);
    expect(within(screen.getByTestId("kudo-letter")).getByTestId("kudo-text").textContent).toBe("Second thanks.");
  });

  it("slides a note set down in place off the pile, opaque and clipped, never faded over the next", async () => {
    const anim = recordAnimations();
    const rects = placeRows({ k1: 5000 });
    try {
      kudos = [letter("k1"), letter("k2", { text: "Second thanks.", createdAt: "2026-09-03T08:00:00.000Z" })];
      mount();
      const button = await screen.findByRole("button", { name: putName });
      await waitFor(() => expect(button.hasAttribute("inert")).toBe(false), { timeout: 1500 });
      await userEvent.click(button);
      await screen.findByTestId("kudo-k1");
      const off = anim.calls.find((c) => c.el.textContent?.includes("Thanks for k1.") && JSON.stringify(c.frames).includes("translateY"));
      expect(off).toBeTruthy();
      // Opaque on every frame: no crossfade, so two texts are never overlaid.
      expect(JSON.stringify(off!.frames)).not.toContain("opacity");
      // It leaves the slot entirely, downwards: the last frame is at least its own height down.
      const last = off!.frames[off!.frames.length - 1].transform as string;
      expect(Number(/translateY\((-?[\d.]+)px\)/.exec(last)![1])).toBeGreaterThanOrEqual(90);
      // Pushed from rest, then friction, like every other part of the move.
      expect(off!.frames[0].easing).toBe("cubic-bezier(0.333, 0, 0.667, 0.333)");
      // Clipped by the letter, so it goes out of the slot rather than over the wall.
      expect(getComputedStyle(off!.el.parentElement!).overflow).toMatch(/clip|hidden/);
    } finally {
      rects.restore();
      anim.restore();
    }
  });

  it("draws no focus ring round the row's empty slot until the note has arrived", async () => {
    const anim = recordAnimations();
    const rects = placeRows({ k1: 420 });
    try {
      kudos = [letter("k1")];
      mount();
      await userEvent.click(await screen.findByRole("button", { name: putName }));
      const row = await screen.findByTestId("kudo-k1");
      expect(document.activeElement).toBe(row);
      expect(row.style.outlineStyle).toBe("none");
      anim.finish();
      await waitFor(() => expect(screen.queryByTestId("kudo-letter-block")).toBe(null));
      expect(row.style.outlineStyle).toBe("");
    } finally {
      rects.restore();
      anim.restore();
    }
  });

  it("has no axe violations with letters waiting", async () => {
    kudos = [letter("k1"), letter("k2")];
    const { container } = mount();
    await screen.findByTestId("kudo-letter");
    await expectNoViolations(container);
  });
});

describe("ago", () => {
  // Hand-written literals: computing these from the same arithmetic the helper
  // uses would pass for any implementation.
  const now = Date.parse("2026-09-03T12:00:00.000Z");
  it.each([
    ["2026-09-03T11:59:30.000Z", "just now"],
    ["2026-09-03T11:45:00.000Z", "15m ago"],
    ["2026-09-03T09:00:00.000Z", "3h ago"],
    ["2026-08-31T12:00:00.000Z", "3d ago"],
  ])("%s reads as %s", (iso, want) => {
    expect(ago(iso, now)).toBe(want);
  });
});

describe("Kudos answer", () => {
  const toMarcus: Kudo = {
    id: "k1",
    fromUserId: "dana",
    toUserId: "marcus",
    text: "Paired on the flaky test all afternoon.",
    createdAt: "2026-09-03T09:00:00.000Z",
    sessionId: "",
    unread: false,
  };
  const answerButton = () => screen.findByRole("button", { name: /^Answer Dana Whitfield/ });
  const field = () => screen.getByLabelText("Your answer to Dana Whitfield");
  const writes = () => vi.mocked(api).mock.calls.filter(([m]) => m !== "GET");

  it("offers Answer to the recipient alone, and never says a kudo is unanswered", async () => {
    kudos = [toMarcus];
    mount();
    expect(await answerButton()).toBeTruthy();
    cleanup();
    for (const meId of ["dana", "someone-else"]) {
      mount({ meId });
      await screen.findByTestId("kudo-k1");
      expect(screen.queryByRole("button", { name: /answer/i })).toBe(null);
      expect(screen.getByTestId("kudos").textContent).not.toMatch(/answer|repl/i);
      cleanup();
    }
  });

  it("answers inline: Enter sends, and focus lands on the line itself", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    expect(document.activeElement).toBe(field());
    await userEvent.type(field(), "Any time.{Enter}");
    expect(vi.mocked(api)).toHaveBeenCalledWith("PUT", "/api/orgs/acme/spaces/platform-team/kudos/k1/answer", {
      text: "Any time.",
    });
    const line = await screen.findByTestId("kudo-answer");
    expect(line.textContent).toContain("You: Any time.");
    expect(screen.queryByRole("button", { name: /^answer/i })).toBe(null);
    await waitFor(() => expect(document.activeElement).toBe(line));
  });

  it("keeps the answer when Enter is pressed again, or held, after sending", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "Any time.{Enter}");
    await screen.findByTestId("kudo-answer");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter>5/}");
    await new Promise((r) => setTimeout(r, 20));
    expect(writes()).toEqual([["PUT", "/api/orgs/acme/spaces/platform-team/kudos/k1/answer", { text: "Any time." }]]);
    expect(screen.getByTestId("kudo-answer").textContent).toContain("Any time.");
  });

  it("sends once for a held Enter in the field", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "Any time.");
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Enter", repeat: true });
    fireEvent.keyDown(field(), { key: "Enter", repeat: true });
    await screen.findByTestId("kudo-answer");
    expect(writes()).toHaveLength(1);
  });

  it("does not send while an input method is still composing", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    fireEvent.change(field(), { target: { value: "ありがとう" } });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 });
    expect(writes()).toEqual([]);
    expect(field()).toBeTruthy();
  });

  it("keeps focus in the field while sending and after a failure, never on the page", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    let release!: () => void;
    answerHold = new Promise((r) => (release = r));
    answerFail = 500;
    await userEvent.type(field(), "Any time.{Enter}");
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute("aria-disabled")).toBe("true");
    release();
    await waitFor(() => expect(field().getAttribute("aria-disabled")).toBe(null));
    expect(document.activeElement).toBe(field());
    expect((field() as HTMLInputElement).value).toBe("Any time.");
  });

  it("says plainly when the kudo was withdrawn while the answer was being written", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "Any time.");
    kudos = [];
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("kudo-k1")).toBe(null));
    expect(await screen.findByText("Dana Whitfield withdrew this thank-you.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/404|no such kudo/);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("shows the answer already given when a second one is refused", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "Any time.");
    kudos = [{ ...toMarcus, answer: "Said in another tab." }];
    await userEvent.keyboard("{Enter}");
    const line = await screen.findByTestId("kudo-answer");
    expect(line.textContent).toContain("Said in another tab.");
    expect(screen.queryByLabelText("Your answer to Dana Whitfield")).toBe(null);
    await waitFor(() => expect(document.activeElement).toBe(line));
  });

  it("cancels on Escape or the Cancel button and hands focus back to Answer", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "hm{Escape}");
    expect(screen.queryByLabelText("Your answer to Dana Whitfield")).toBe(null);
    expect(document.activeElement).toBe(await answerButton());
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "hm");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Your answer to Dana Whitfield")).toBe(null);
    expect(document.activeElement).toBe(await answerButton());
    expect(writes()).toEqual([]);
  });

  it("shows the counter only near 80 runes and says why Enter did nothing", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    fireEvent.change(field(), { target: { value: "🎉".repeat(50) } });
    expect(screen.queryByTestId("answer-left")).toBe(null);
    fireEvent.change(field(), { target: { value: "🎉".repeat(81) } });
    expect(screen.getByTestId("answer-left").textContent).toContain("1");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByTestId("answer-hint").textContent).toMatch(/80 characters/);
    fireEvent.change(field(), { target: { value: "   " } });
    expect(screen.getByTestId("answer-hint").textContent).toBe("Enter to send");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByTestId("answer-hint").textContent).toMatch(/write something/i);
    expect(writes()).toEqual([]);
  });

  it("asks before withdrawing an answer, and Keep it keeps it", async () => {
    kudos = [{ ...toMarcus, answer: "Any time." }];
    mount({ meId: "dana" });
    expect((await screen.findByTestId("kudo-answer")).textContent).toContain("Marcus Okonjo: Any time.");
    expect(screen.queryByRole("button", { name: /answer/i })).toBe(null);
    cleanup();

    mount();
    const withdraw = await screen.findByRole("button", { name: /^Withdraw answer to Dana Whitfield/ });
    expect(withdraw.textContent).toBe("Withdraw answer");
    await userEvent.click(withdraw);
    expect(writes()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("kudo-answer")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Withdraw answer/ }));

    await userEvent.click(screen.getByRole("button", { name: /^Withdraw answer/ }));
    await userEvent.click(screen.getByRole("button", { name: "Withdraw it" }));
    expect(vi.mocked(api)).toHaveBeenCalledWith("DELETE", "/api/orgs/acme/spaces/platform-team/kudos/k1/answer");
    await waitFor(() => expect(screen.queryByTestId("kudo-answer")).toBe(null));
    expect(document.activeElement).toBe(await answerButton());
  });

  it("names each note's controls apart, and marks where the answer begins", async () => {
    kudos = [
      { ...toMarcus, id: "k1", text: "Paired on the flaky test all afternoon." },
      { ...toMarcus, id: "k2", text: "Reviewed the migration twice." },
      { ...toMarcus, id: "k3", text: "Wrote the runbook.", answer: "Cheers." },
      { ...toMarcus, id: "k4", text: "Fixed the build.", answer: "Any time." },
    ];
    mount();
    const names = [
      ...(await screen.findAllByRole("button", { name: /^Answer/ })),
      ...screen.getAllByRole("button", { name: /^Withdraw answer/ }),
    ].map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(4);
    expect(names[0]).toContain("Paired on the flaky");
    for (const line of screen.getAllByTestId("kudo-answer")) expect(line.textContent).toMatch(/^You replied:/);
  });

  it("keeps a witness's timestamp with the note, above the answer", async () => {
    kudos = [{ ...toMarcus, toUserId: "dana", fromUserId: "marcus", answer: "Thanks!" }];
    mount();
    const row = await screen.findByTestId("kudo-k1");
    const time = row.querySelector("time")!;
    const answer = within(row).getByTestId("kudo-answer");
    expect(time.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no axe violations with the answer field open", async () => {
    kudos = [toMarcus];
    const { container } = mount();
    await userEvent.click(await answerButton());
    await expectNoViolations(container);
  });
});

describe("Kudos answer focus", () => {
  it("takes no focus when the wall first renders", async () => {
    kudos = [
      { id: "k1", fromUserId: "dana", toUserId: "marcus", text: "Thanks.", createdAt: "2026-09-03T09:00:00.000Z", sessionId: "", unread: false, answer: "Cheers." },
      { id: "k2", fromUserId: "dana", toUserId: "marcus", text: "Thanks again.", createdAt: "2026-09-03T08:00:00.000Z", sessionId: "", unread: false },
    ];
    mount();
    await screen.findByTestId("kudo-answer");
    expect(document.activeElement).toBe(document.body);
  });
});

describe("Kudos answer, second pass", () => {
  const toMarcus: Kudo = {
    id: "k1",
    fromUserId: "dana",
    toUserId: "marcus",
    text: "Paired on the flaky test all afternoon.",
    createdAt: "2026-09-03T09:00:00.000Z",
    sessionId: "",
    unread: false,
  };
  const toSam: Kudo = { ...toMarcus, id: "k3", fromUserId: "marcus", toUserId: "sam", text: "Wrote the runbook." };
  const answerButton = () => screen.findByRole("button", { name: /^Answer Dana Whitfield/ });
  const field = () => screen.getByLabelText("Your answer to Dana Whitfield");
  /** Every focus() call, with the element it was made on and its options. */
  function spyFocus() {
    const calls: { el: HTMLElement; opts?: FocusOptions }[] = [];
    const real = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, opts) {
      calls.push({ el: this, opts });
      real.call(this, opts);
    });
    return { calls, restore: () => spy.mockRestore() };
  }

  it("leaves focus and scroll alone when somebody else's answer arrives", async () => {
    kudos = [toMarcus, toSam];
    for (const meId of ["dana", "marcus"]) {
      const { queryClient } = mount({ meId });
      await screen.findByTestId("kudo-k3");
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      const focus = spyFocus();
      kudos = [toMarcus, { ...toSam, answer: "It was mostly copied from yours." }];
      await queryClient.invalidateQueries();
      await screen.findByTestId("kudo-answer");
      await new Promise((r) => setTimeout(r, 20));
      focus.restore();
      expect(focus.calls).toEqual([]);
      expect(document.activeElement).toBe(document.body);
      cleanup();
      kudos = [toMarcus, toSam];
    }
  });

  it("moves focus to the sent answer without scrolling the page", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    const focus = spyFocus();
    await userEvent.type(field(), "Any time.{Enter}");
    const line = await screen.findByTestId("kudo-answer");
    await waitFor(() => expect(document.activeElement).toBe(line));
    focus.restore();
    const onLine = focus.calls.filter((c) => c.el === line);
    expect(onLine.length).toBeGreaterThan(0);
    for (const c of onLine) expect(c.opts).toEqual({ preventScroll: true });
  });

  it("closes the field on a saved answer even when the refetch after it fails", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "Any time.");
    wallFails = true;
    await userEvent.keyboard("{Enter}");
    const line = await screen.findByTestId("kudo-answer");
    expect(line.textContent).toContain("You: Any time.");
    expect(screen.queryByLabelText("Your answer to Dana Whitfield")).toBe(null);
    await waitFor(() => expect(document.activeElement).toBe(line));
    // And it still answers: withdrawing works, and so does Keep it.
    await userEvent.click(screen.getByRole("button", { name: /^Withdraw answer/ }));
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("button", { name: "Keep it" })).toBe(null);
  });

  it("leaves the confirm on a withdrawn answer even when the refetch after it fails", async () => {
    kudos = [{ ...toMarcus, answer: "Any time." }];
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /^Withdraw answer/ }));
    wallFails = true;
    await userEvent.click(screen.getByRole("button", { name: "Withdraw it" }));
    expect(await answerButton()).toBeTruthy();
    expect(screen.queryByTestId("kudo-answer")).toBe(null);
    expect(screen.queryByRole("button", { name: "Keep it" })).toBe(null);
    await waitFor(async () => expect(document.activeElement).toBe(await answerButton()));
  });

  it("does not scroll the wall away when a withdrawn kudo sends focus to the heading", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "Any time.");
    kudos = [];
    const focus = spyFocus();
    await userEvent.keyboard("{Enter}");
    await screen.findByText("Dana Whitfield withdrew this thank-you.");
    focus.restore();
    const heading = screen.getByRole("heading", { name: "Kudos" });
    const onHeading = focus.calls.filter((c) => c.el === heading);
    expect(onHeading.length).toBe(1);
    expect(onHeading[0].opts).toEqual({ preventScroll: true });
  });

  it("says Sending while the answer is on its way, and dims the words", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    let release!: () => void;
    answerHold = new Promise((r) => (release = r));
    await userEvent.type(field(), "Any time.{Enter}");
    const hint = screen.getByTestId("answer-hint");
    expect(hint.textContent).toBe("Sending…");
    expect(hint.getAttribute("aria-live")).toBe("polite");
    expect(field().className).toMatch(/opacity-/);
    release();
    await screen.findByTestId("kudo-answer");
  });

  it("asks the question the withdraw buttons answer", async () => {
    kudos = [{ ...toMarcus, answer: "Any time." }];
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /^Withdraw answer/ }));
    const prompt = screen.getByText("Withdraw your answer?");
    for (const name of ["Keep it", "Withdraw it"]) {
      const b = screen.getByRole("button", { name });
      expect(b.getAttribute("aria-describedby")).toBe(prompt.id);
    }
    expect(prompt.id).not.toBe("");
  });

  it("keeps the words typed when the kudo turns out to be answered already", async () => {
    kudos = [toMarcus];
    mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "Typed in this tab.");
    kudos = [{ ...toMarcus, answer: "Said in another tab." }];
    await userEvent.keyboard("{Enter}");
    await screen.findByTestId("kudo-answer");
    const note = await screen.findByTestId("answer-unsent");
    expect(note.textContent).toContain("You already answered this");
    expect(note.textContent).toContain("Typed in this tab.");
  });

  it("closes the field on a refused answer, keeps the words in a polite note, and sends nothing more", async () => {
    kudos = [toMarcus];
    const { queryClient } = mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "Typed in this tab.");
    kudos = [{ ...toMarcus, answer: "Said in another tab." }];
    wallFails = true;
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByLabelText("Your answer to Dana Whitfield")).toBe(null));
    const note = screen.getByTestId("answer-unsent");
    expect(note.textContent).toContain("Typed in this tab.");
    expect(note.closest('[aria-live="polite"]')).not.toBe(null);
    await waitFor(() => expect(document.activeElement).toBe(note));
    // Refused is refused until the wall is read again: no Answer, no Enter.
    expect(screen.queryByRole("button", { name: /^Answer Dana Whitfield/ })).toBe(null);
    await userEvent.keyboard("{Enter}");
    expect(vi.mocked(api).mock.calls.filter(([m]) => m === "PUT")).toHaveLength(1);
    // Leaving the note puts it away, and gives up the focus hand-off with it.
    act(() => note.blur());
    await waitFor(() => expect(screen.queryByTestId("answer-unsent")).toBe(null));
    expect(document.activeElement).toBe(document.body);
    wallFails = false;
    const focus = spyFocus();
    await act(() => queryClient.invalidateQueries());
    await screen.findByTestId("kudo-answer");
    await new Promise((r) => setTimeout(r, 20));
    focus.restore();
    expect(focus.calls).toEqual([]);
    expect(document.activeElement).toBe(document.body);
  });

  it("lets the server win over an answer shown from a write whose refetch failed", async () => {
    kudos = [toMarcus];
    const { queryClient } = mount();
    await userEvent.click(await answerButton());
    await userEvent.type(field(), "Only here.");
    wallFails = true;
    await userEvent.keyboard("{Enter}");
    expect((await screen.findByTestId("kudo-answer")).textContent).toContain("Only here.");
    // Withdrawn in another tab; the next good read has no answer.
    kudos = [toMarcus];
    wallFails = false;
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(screen.queryByTestId("kudo-answer")).toBe(null));
    expect(await answerButton()).toBeTruthy();
  });

  it("lets the server win over a withdrawal shown from a write whose refetch failed", async () => {
    kudos = [{ ...toMarcus, answer: "Any time." }];
    const { queryClient } = mount();
    await userEvent.click(await screen.findByRole("button", { name: /^Withdraw answer/ }));
    wallFails = true;
    await userEvent.click(screen.getByRole("button", { name: "Withdraw it" }));
    await waitFor(() => expect(screen.queryByTestId("kudo-answer")).toBe(null));
    // The same answer, given again in another tab.
    kudos = [{ ...toMarcus, answer: "Any time." }];
    wallFails = false;
    await act(() => queryClient.invalidateQueries());
    expect((await screen.findByTestId("kudo-answer")).textContent).toContain("Any time.");
  });
});
