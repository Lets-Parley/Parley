import { describe, it, vi } from "vitest";
import { renderApp, makePerson } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { Avatar } from "./Avatar";
import { ConnectionBanner } from "./ConnectionBanner";
import { Hand } from "./Hand";
import { KindChip } from "./KindChip";
import { MemberCard } from "./MemberCard";
import { ResultsPanel } from "./ResultsPanel";

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
