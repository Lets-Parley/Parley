import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, makePerson } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { api, type Kudo } from "../lib/api";
import { Kudos, ago } from "./Kudos";

let kudos: Kudo[] = [];

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string, path: string) => {
      if (path.endsWith("/kudos") && method === "GET") return kudos;
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
});

describe("Kudos wall", () => {
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
    mount({ members: bidiMembers });
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

  it("has no axe violations", async () => {
    kudos = [
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
      toUserId: "marcus",
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
