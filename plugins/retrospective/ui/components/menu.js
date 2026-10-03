import { GLYPH } from "../assets/glyphs.js";
import { contains, el, icon } from "../utils/dom.js";
import { notify } from "./notices.js";
import { closePop, layer, openPop, placePop, pop } from "./popover.js";

// A menu is a list of rows, and a row is one of four things:
//
//   { label, icon, keys, kind, off, danger, stay, run }   an item
//   { sep: true }                                         a rule
//   { strip, keys, off, items }                           small buttons on one line
//   { label, icon, title, sub }                           a step in: `sub` is the rows shown instead, under a Back row
//
// `off` holds the reason an item cannot be used just now: it is written
// under the item and said when the item is chosen. `stay` keeps the menu
// open, as a strip's buttons always do, for what is pressed several times
// running. `rows` may be a function, and is then asked again whenever the
// board changes, so an open menu is never about a board that has gone.
// `title` is shown above the rows and `note` under them.
let whys = 0;

export function openMenu(anchor, label, rows, title, note) {
  const menu = el("div", { class: "pop menu", role: "menu", "aria-label": label });
  const rowsNow = typeof rows === "function" ? rows : function () { return rows; };
  const phone = !!(window.matchMedia && window.matchMedia("(max-width:480px)").matches);
  // The label of the row that was stepped into, or null at the top.
  let step = null;
  // The buttons, row by row: a strip is one row. And all of them in order.
  let grid = [];
  let flat = [];
  let drawn = "";

  function specNow() {
    const top = rowsNow();
    const from = top.filter(function (row) {
      return row.sub && row.label === step;
    })[0];
    if (!from) step = null;
    return { rows: from ? from.sub() : top, back: from ? from.title || from.label : "", title: typeof title === "function" ? title() : title };
  }

  function sigOf(spec) {
    return JSON.stringify(spec, function (key, value) {
      return typeof value === "function" ? 1 : value;
    });
  }

  function choose(row) {
    if (row.off) {
      notify(row.off);
      return;
    }
    if (row.sub) {
      step = row.label;
      draw(1);
      return;
    }
    if (!row.stay) closePop(true);
    row.run();
  }

  function button(row, attrs, kids) {
    const btn = el("button", Object.assign({ type: "button", role: "menuitem", tabindex: -1 }, attrs), kids);
    if (row.off) btn.setAttribute("aria-disabled", "true");
    btn.addEventListener("click", function () {
      choose(row);
    });
    flat.push({ el: btn, label: row.label });
    return btn;
  }

  function why(off, btns) {
    const id = "menu-why-" + ++whys;
    btns.forEach(function (btn) {
      btn.setAttribute("aria-describedby", id);
    });
    menu.appendChild(el("p", { id: id, class: "off-why", text: off }));
  }

  function stepBack() {
    const from = step;
    step = null;
    draw(from);
  }

  // `want` is the row to put focus on: its label, or its place.
  function draw(want) {
    const spec = specNow();
    drawn = sigOf(spec);
    while (menu.lastChild) menu.removeChild(menu.lastChild);
    grid = [];
    flat = [];
    const iconed = spec.rows.some(function (row) {
      return row.icon;
    });
    if (spec.back) {
      const back = button({ label: "Back", stay: true, run: stepBack }, { class: "menu-item back", "aria-label": "Back" }, [icon(GLYPH.back), el("span", { class: "w", text: spec.back })]);
      menu.appendChild(back);
      grid.push([back]);
    } else if (spec.title) menu.appendChild(el("p", { class: "label menu-title", "aria-hidden": "true", text: spec.title }));
    spec.rows.forEach(function (row, i) {
      if (row.sep) {
        // A rule stands between two things, never first, last or twice.
        const next = spec.rows[i + 1];
        if (grid.length > (spec.back ? 1 : 0) && next && !next.sep) menu.appendChild(el("div", { class: "sep", role: "separator" }));
        return;
      }
      if (row.strip) {
        const btns = row.items.map(function (item) {
          return button({ label: item.label, off: row.off, stay: true, run: item.run }, { "aria-label": item.label, title: item.label + " (" + item.keys + ")" }, [icon(item.icon)]);
        });
        const name = el("span", { class: "w" }, [el("span", { text: row.strip }), el("span", { class: "keys", "aria-hidden": "true", text: row.keys })]);
        menu.appendChild(el("div", { class: "strip", role: "group", "aria-label": row.strip }, [name].concat(btns)));
        grid.push(btns);
        if (row.off) why(row.off, btns);
        return;
      }
      const kids = [el("span", { class: "w", text: row.label })];
      if (row.icon) kids.unshift(icon(row.icon));
      else if (iconed) kids.unshift(el("span", { class: "menu-gap" }));
      if (row.keys) kids.push(el("span", { class: "keys", "aria-hidden": "true", text: row.keys }));
      if (row.kind) kids.push(el("span", { class: "menu-kind", text: row.kind }));
      if (row.sub) kids.push(icon(GLYPH.into));
      const btn = button(row, { class: "menu-item" + (row.danger ? " danger" : "") }, kids);
      if (row.sub) btn.setAttribute("aria-haspopup", "menu");
      menu.appendChild(btn);
      grid.push([btn]);
      if (row.off) why(row.off, [btn]);
    });
    if (note) menu.appendChild(el("p", { class: "fine menu-note", text: note }));
    // On a phone the menu is a sheet, and a sheet has a way out in sight.
    if (phone) {
      const done = button({ label: "Done", run: function () {} }, { class: "menu-item menu-done" }, [el("span", { text: "Done" })]);
      menu.appendChild(done);
      grid.push([done]);
    }
    if (pop && pop.el === menu) placePop(true);
    if (want === undefined || !flat.length) return;
    const named = flat.filter(function (f) {
      return f.label === want;
    })[0];
    (named || flat[Math.min(typeof want === "number" ? want : 0, flat.length - 1)]).el.focus({ preventScroll: true });
  }

  menu.addEventListener("keydown", function (ev) {
    const held = document.activeElement;
    const n = grid.length;
    if (!n) return;
    let r = -1;
    let c = 0;
    grid.forEach(function (row, i) {
      if (row.indexOf(held) === -1) return;
      r = i;
      c = row.indexOf(held);
    });
    const key = ev.key;
    const across = r !== -1 && grid[r].length > 1;
    let to = null;
    if (key === "ArrowDown") to = grid[(r + 1) % n][0];
    else if (key === "ArrowUp") to = grid[(Math.max(r, 0) - 1 + n) % n][0];
    else if (key === "Home") to = grid[0][0];
    else if (key === "End") to = grid[n - 1][0];
    else if (across && (key === "ArrowRight" || key === "ArrowLeft")) to = grid[r][(c + (key === "ArrowRight" ? 1 : grid[r].length - 1)) % grid[r].length];
    else if (key === "ArrowRight" && held.getAttribute && held.getAttribute("aria-haspopup") === "menu" && contains(menu, held)) {
      ev.preventDefault();
      held.click();
      return;
    } else if ((key === "ArrowLeft" || key === "Escape") && step !== null) {
      // One level at a time: out of the step first, then out of the menu.
      ev.preventDefault();
      ev.stopPropagation();
      stepBack();
      return;
    } else if (key === "Tab" && phone) {
      // A sheet keeps Tab inside itself, as the other sheets do.
      const at = flat.findIndex(function (f) {
        return f.el === held;
      });
      to = flat[(Math.max(at, 0) + (ev.shiftKey ? flat.length - 1 : 1)) % flat.length].el;
    } else if (key === "Tab") {
      closePop(true);
      return;
    } else if (key.length === 1 && key !== " " && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      // Type a letter to reach the next item that starts with it.
      const at = flat.findIndex(function (f) {
        return f.el === held;
      });
      for (let i = 1; i <= flat.length && !to; i++) {
        const item = flat[(at + i) % flat.length];
        if (item.label.toLowerCase().indexOf(key.toLowerCase()) === 0) to = item.el;
      }
    }
    if (!to) return;
    ev.preventDefault();
    to.focus();
  });
  draw();
  menu.rises = phone;
  // The board changed under the menu: the rows are asked for again, and
  // drawn again only if they differ, with focus on the row it was on.
  openPop(anchor, menu, function () {
    const at = flat.findIndex(function (f) {
      return f.el === document.activeElement;
    });
    if (sigOf(specNow()) === drawn) return;
    const want = at === -1 ? undefined : flat[at].label;
    draw(want);
    // The row focus was on is gone: the one now in its place takes it.
    if (at !== -1 && !contains(menu, document.activeElement) && flat.length) flat[Math.min(at, flat.length - 1)].el.focus({ preventScroll: true });
  });
  // On a phone the menu is a sheet along the bottom, over a scrim.
  pop.under = el("div", { class: "scrim", "aria-hidden": "true" });
  layer.insertBefore(pop.under, menu);
  if (flat.length) flat[0].el.focus({ preventScroll: true });
}

// Deleting cannot be taken back, so it is asked about. The sheet opens with
// focus on the way out: no single key, held or repeated, deletes anything.
export function openConfirm(anchor, title, detail, label, run) {
  const keep = el("button", { type: "button", class: "btn btn-primary btn-small", text: "Keep it" });
  const go = el("button", { type: "button", class: "btn btn-quiet btn-small danger", text: label });
  const panel = el("div", { class: "pop sheet", role: "alertdialog", "aria-label": title, "aria-describedby": "confirm-detail" }, [
    el("p", { class: "sheet-title", text: title }),
    el("p", { id: "confirm-detail", class: "fine", text: detail }),
    el("div", { class: "row" }, [keep, go]),
  ]);
  keep.addEventListener("click", function () {
    closePop(true);
  });
  go.addEventListener("click", function () {
    closePop(true);
    run();
  });
  openPop(anchor, panel);
  keep.focus();
}

