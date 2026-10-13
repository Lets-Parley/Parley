import { afterEach, expect, it } from "vitest";
import { focusNeutral, isNeutralFocusTarget, preventsKeyRepeat } from "./neutralFocus";

afterEach(() => {
  document.body.innerHTML = "";
});

it("never hands focus to a control whose activation writes to the room", () => {
  document.body.innerHTML = `
    <button id="reveal">Reveal</button>
    <a id="link" href="#x">Deal</a>
    <div id="fake" role="button" tabindex="0">Save</div>
    <input id="field" />
    <button id="toggle" data-neutral-control>Hide the split</button>
    <section id="region" tabindex="-1" aria-label="On the table"></section>
    <h2 id="heading" tabindex="-1">Ticket</h2>`;
  const byId = (id: string) => document.getElementById(id)!;
  expect(["reveal", "link", "fake", "field"].map((id) => isNeutralFocusTarget(byId(id)))).toEqual([false, false, false, false]);
  expect(["toggle", "region", "heading"].map((id) => isNeutralFocusTarget(byId(id)))).toEqual([true, true, true]);

  expect(focusNeutral([byId("reveal"), null, byId("region"), byId("heading")])).toBe(byId("region"));
  expect(document.activeElement).toBe(byId("region"));
  byId("region").remove();
  expect(focusNeutral([byId("reveal"), byId("link")])).toBeNull();
  expect(document.activeElement).toBe(document.body);
  expect(focusNeutral([byId("toggle")])).toBe(byId("toggle"));
});

it("lets a held key activate a committing control once", () => {
  const repeated = (key: string, isRepeat: boolean) => {
    let isPrevented = false;
    preventsKeyRepeat({ key, repeat: isRepeat, preventDefault: () => (isPrevented = true) });
    return isPrevented;
  };
  expect(repeated("Enter", true)).toBe(true);
  expect(repeated(" ", true)).toBe(true);
  expect(repeated("Enter", false)).toBe(false);
  expect(repeated("Tab", true)).toBe(false);
});
