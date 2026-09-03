import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, makePerson } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { Avatar } from "./Avatar";
import { ConnectionBanner } from "./ConnectionBanner";
import { Hand } from "./Hand";
import { KindChip } from "./KindChip";
import { MemberCard } from "./MemberCard";
import { ResultsPanel } from "./ResultsPanel";
import { Kudos } from "./Kudos";

/**
 * The kudos wall owns a fetch, so it cannot join the props-only sweep below.
 * Its own accessibility case sits in this file because the give form is where
 * a keyboard user meets the feature.
 */
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: vi.fn(async (method: string) => (method === "GET" ? [] : undefined)),
  };
});

/**
 * One axe sweep per screen part that renders from props alone. It is a floor,
 * not a certificate: axe catches roughly the machine-checkable half of WCAG,
 * and in jsdom it cannot see colour or layout at all. Anything failing here is
 * a real defect; passing here means the obvious ones are gone.
 *
 * Components that own fetches assert their own accessibility inside their own
 * tests, where the mock already exists — add `expectNoViolations` there rather
 * than rebuilding the fixture in this file.
 */
const cases: [string, () => React.ReactElement][] = [
  ["Avatar", () => <Avatar name="Dana Whitfield" hue={120} />],
  ["ConnectionBanner", () => <ConnectionBanner status="stale" onRetry={vi.fn()} />],
  [
    "Hand",
    () => (
      <Hand
        values={["1", "2", "3", "5", "coffee"]}
        deckName="fibonacci"
        selected="3"
        spectating={false}
        canSpectate
        status="live"
        onPick={vi.fn()}
        onToggleSpectate={vi.fn()}
      />
    ),
  ],
  ["KindChip", () => <KindChip kind="poker" />],
  [
    "MemberCard",
    () => <MemberCard member={makePerson()} isYou={false} onClose={vi.fn()} />,
  ],
  [
    "ResultsPanel",
    () => (
      <ResultsPanel
        results={{
          histogram: [
            { value: "3", count: 2 },
            { value: "5", count: 1 },
          ],
          average: 3.7,
          median: 3,
          mode: "3",
          range: "3–5",
          consensus: false,
        }}
        deck={["1", "2", "3", "5", "8"]}
      />
    ),
  ],
];

describe("accessibility", () => {
  it.each(cases)("%s has no axe violations", async (_name, ui) => {
    const { container } = renderApp(ui());
    await expectNoViolations(container);
  });
});

describe("the kudos give form", () => {
  const members = [
    makePerson({ userId: "marcus", name: "Marcus Okonjo" }),
    makePerson({ userId: "dana", name: "Dana Whitfield" }),
  ];

  it("is reachable, labelled and announces what it did, from the keyboard alone", async () => {
    renderApp(<Kudos org="acme" slug="platform-team" members={members} meId="marcus" />);
    const picker = await screen.findByLabelText("To");
    const text = screen.getByLabelText("For what");
    const give = screen.getByRole("button", { name: "Give kudos" });

    // Tabbing from the top of the panel reaches all three in order — no
    // control is a div that only a mouse can operate. Filled in first,
    // because a disabled submit is not in the tab order at all and the
    // sequence would then prove nothing about the button.
    await userEvent.selectOptions(picker, "dana");
    picker.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(text);
    await userEvent.keyboard("Held the line on the release.");
    await userEvent.tab();
    expect(document.activeElement).toBe(give);

    text.focus();
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Kudos sent"));
  });
});
