import { afterEach, expect, it } from "vitest";
import { focusNeutral, isNeutralFocusTarget, swallowHeldActivation } from "./neutralFocus";

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
  document.body.innerHTML = `
    <button id="deal">Deal</button>
    <input id="box" type="checkbox" />
    <a id="link" href="#x">Deal</a>
    <div id="item" role="menuitem" tabindex="0">Remove</div>
    <section id="region" tabindex="-1"></section>
    <input id="title" />
    <textarea id="notes"></textarea>
    <select id="card"><option>1</option></select>
    <div id="rich" contenteditable="true"></div>`;
  const isSwallowed = (id: string, key: string, isRepeat = true) => {
    let isPrevented = false;
    let isStopped = false;
    swallowHeldActivation({
      key,
      repeat: isRepeat,
      target: document.getElementById(id),
      preventDefault: () => (isPrevented = true),
      stopPropagation: () => (isStopped = true),
    });
    return isPrevented && isStopped;
  };
  expect(["deal", "box", "link", "item", "region"].map((id) => isSwallowed(id, "Enter"))).toEqual([true, true, true, true, true]);
  expect(["deal", "box"].map((id) => isSwallowed(id, " "))).toEqual([true, true]);
  expect(isSwallowed("deal", "Enter", false)).toBe(false);
  expect(isSwallowed("deal", "Tab")).toBe(false);
  expect(["title", "notes", "card", "rich"].map((id) => isSwallowed(id, "Enter"))).toEqual([false, false, false, false]);
});
