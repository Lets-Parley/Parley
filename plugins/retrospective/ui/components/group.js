import { GLYPH } from "../assets/glyphs.js";
import { el, icon, setText } from "../utils/dom.js";
import { plural } from "../utils/text.js";
import { actionsFrom, groupById, ui, view } from "../bridge/state.js";
import { toggles } from "./popover.js";
import { openMenu } from "./menu.js";
import { SORTED_OFF } from "./lane.js";
import { ARROWS, saysHowToMove, signed } from "./note.js";
import { reorderStrip } from "./note-menu.js";
import { moveGroup, sideways, toLane } from "../features/moves.js";
import { drags } from "../features/drag.js";
import { openLinks } from "./links.js";

// ----------------------------------------------------------------- groups

export function buildGroup(id) {
  const group = {
    grip: el("button", { type: "button", class: "grip", "aria-describedby": "grip-help" }, [icon(GLYPH.grip)]),
    more: el("button", { type: "button", class: "more", "aria-haspopup": "menu", title: "Options" }, [icon(GLYPH.dots, 3)]),
    title: el("h3", { tabindex: -1, dir: "auto" }),
    meta: el("p", { class: "group-meta" }),
    target: el("button", { type: "button", class: "target", "aria-haspopup": "dialog" }, [icon(GLYPH.target)]),
    targetCount: el("span", { class: "mono" }),
    list: el("ul", { class: "notes" }),
  };
  group.target.appendChild(group.targetCount);
  group.head = el("div", { class: "group-head" }, [group.grip, el("div", { class: "group-title" }, [group.title, group.meta]), group.target, group.more]);
  group.el = el("li", { class: "group" }, [group.head, group.list]);

  toggles(group.more, function () {
    openMenu(
      group.more,
      "Options for group: " + groupById(id).title,
      function () {
        const g = groupById(id);
        if (!g) return [];
        const linked = actionsFrom(id).length;
        const lanes = ui.board.columns
          .filter(function (col) {
            return col.id !== g.columnId;
          })
          .map(function (col) {
            return {
              label: col.title,
              kind: "lane",
              run: function () {
                toLane("group", id, col.id);
              },
            };
          });
        const rows = [
          {
            label: linked ? "Actions from this group (" + linked + ")…" : "Start an action…",
            icon: GLYPH.target,
            run: function () {
              openLinks(id, group.more);
            },
          },
          { sep: true },
          reorderStrip(view.lanes[g.columnId].sorted ? SORTED_OFF : "", "Move group", function (way) {
            moveGroup(id, way);
          }),
        ];
        if (lanes.length) {
          rows.push({
            label: "Move to…",
            title: "Move group to",
            icon: GLYPH.move,
            sub: function () {
              return lanes;
            },
          });
        }
        return rows;
      },
      function () {
        const g = groupById(id);
        return g ? g.title : "";
      },
    );
  });
  saysHowToMove(group.grip, group);
  drags(group.grip, "group", id);
  drags(group.head, "group", id);
  toggles(group.target, function () {
    openLinks(id, group.target);
  });
  group.head.addEventListener("keydown", function (ev) {
    const way = ev.altKey && ARROWS[ev.key];
    if (!way) return;
    ev.preventDefault();
    if (way === "left" || way === "right") sideways("group", id, way === "left" ? -1 : 1);
    else moveGroup(id, ev.shiftKey ? (way === "up" ? "top" : "bottom") : way);
  });
  return group;
}

export function patchGroup(group, item) {
  const linked = actionsFrom(item.id).length;
  const title = item.group.title;
  setText(group.title, title);
  group.title.setAttribute("title", title);
  // The score first, and the split only when there are downs to tell apart.
  setText(group.meta, plural(item.cards.length, "note") + (item.up + item.down ? " · " + signed(item.up - item.down) + (item.down ? " (" + (item.up ? item.up + " up · " : "") + item.down + " down)" : "") : ""));
  group.grip.setAttribute("aria-label", "Drag to reorder group: " + title);
  group.more.setAttribute("aria-label", "Options for group: " + title);
  group.target.hidden = ui.board.stage !== 3 && linked === 0;
  group.target.classList.toggle("linked", linked > 0);
  group.target.setAttribute("aria-label", linked ? plural(linked, "action") + " from group: " + title + ". Open." : "Start an action from group: " + title);
  group.targetCount.hidden = linked === 0;
  setText(group.targetCount, String(linked));
}

