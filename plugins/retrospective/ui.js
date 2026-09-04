(function () {
  "use strict";

  var root = document.getElementById("root");
  var selected = {};

  function el(html) {
    root.innerHTML = html;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function boardOf(session) {
    var b = session && session.state;
    if (!b || typeof b !== "object") {
      return { columns: [], cards: [], groups: [], actionItems: [], revealed: false };
    }
    return b;
  }

  function onClick(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var act = t.getAttribute("data-act");
    if (!act) return;
    if (act === "select") {
      var id = t.getAttribute("data-id");
      selected[id] = !selected[id];
      draw(window.parley.state());
      return;
    }
    if (act === "add-card") {
      var col = t.getAttribute("data-col");
      var input = root.querySelector('input[data-col="' + col + '"]');
      var text = input ? input.value : "";
      window.parley.act("add-card", { columnId: col, text: text });
      return;
    }
    if (act === "vote") {
      window.parley.act("vote", { cardId: t.getAttribute("data-id") });
      return;
    }
    if (act === "reveal") {
      window.parley.act("reveal", {});
      return;
    }
    if (act === "group") {
      var ids = Object.keys(selected).filter(function (k) { return selected[k]; });
      var titleInput = root.querySelector("[data-group-title]");
      window.parley.act("group-cards", {
        cardIds: ids,
        title: titleInput ? titleInput.value : "group",
      });
      selected = {};
      return;
    }
    if (act === "add-action") {
      var textEl = root.querySelector("[data-action-text]");
      var ownerEl = root.querySelector("[data-action-owner]");
      window.parley.act("add-action", {
        text: textEl ? textEl.value : "",
        owner: ownerEl ? ownerEl.value : "",
      });
    }
  }

  function draw(session) {
    var board = boardOf(session);
    var cols = board.columns || [];
    var cards = board.cards || [];
    var groups = board.groups || [];
    var actions = board.actionItems || [];
    var html = '<div style="display:flex;flex-direction:column;height:100%;min-height:100%;box-sizing:border-box;padding:12px;gap:12px">';
    html += '<header style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">';
    html += "<h1 style=\"margin:0;font-size:1.1rem\">Retrospective</h1>";
    html += "<div>";
    html += '<input data-group-title placeholder="group title" style="margin-right:6px">';
    html += '<button type="button" data-act="group">Group selected</button> ';
    html += '<button type="button" data-act="reveal">Reveal authorship</button>';
    if (board.revealed) html += ' <span>Authorship is visible.</span>';
    html += "</div></header>";
    html += '<div style="display:flex;gap:12px;flex:1;min-height:0;align-items:stretch">';
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      html += '<section style="flex:1;min-width:0;border:1px solid var(--color-line,#ccc);border-radius:8px;padding:8px;background:var(--color-surface-hi,transparent);display:flex;flex-direction:column">';
      html += "<h2 style=\"margin:0 0 8px;font-size:1rem\">" + esc(col.title || "Went well") + "</h2>";
      html += '<div style="flex:1;overflow:auto">';
      for (var g = 0; g < groups.length; g++) {
        if (groups[g].columnId !== col.id) continue;
        html += '<p style="margin:8px 0 4px;font-weight:600">' + esc(groups[g].title) + "</p>";
      }
      for (var c = 0; c < cards.length; c++) {
        var card = cards[c];
        if (card.columnId !== col.id) continue;
        var checked = selected[card.id] ? " checked" : "";
        html += '<article style="border:1px solid var(--color-line,#ddd);border-radius:6px;padding:8px;margin:0 0 8px">';
        html += '<label><input type="checkbox" data-act="select" data-id="' + esc(card.id) + '"' + checked + "> " + esc(card.text) + "</label>";
        if (board.revealed && card.authorId) html += '<div style="color:var(--color-ink-soft,#555);font-size:0.85rem">' + esc(card.authorId) + "</div>";
        html += '<div><button type="button" data-act="vote" data-id="' + esc(card.id) + '">vote</button> ';
        html += "<span>" + esc(card.voteCount || 0) + "</span></div></article>";
      }
      html += "</div>";
      html += '<div style="display:flex;gap:6px;margin-top:8px">';
      html += '<input data-col="' + esc(col.id) + '" placeholder="Add a card" style="flex:1">';
      html += '<button type="button" data-act="add-card" data-col="' + esc(col.id) + '">Add</button>';
      html += "</div></section>";
    }
    html += "</div>";
    html += '<section style="border-top:1px solid var(--color-line,#ccc);padding-top:8px">';
    html += "<h2 style=\"margin:0 0 8px;font-size:1rem\">Action items</h2>";
    html += "<ul>";
    for (var a = 0; a < actions.length; a++) {
      html += "<li>" + esc(actions[a].text);
      if (actions[a].owner) html += " — " + esc(actions[a].owner);
      html += "</li>";
    }
    html += "</ul>";
    html += '<div style="display:flex;gap:6px">';
    html += '<input data-action-text placeholder="Action item" style="flex:1">';
    html += '<input data-action-owner placeholder="owner">';
    html += '<button type="button" data-act="add-action">Add</button>';
    html += "</div></section></div>";
    el(html);
  }

  root.addEventListener("click", onClick);
  window.parley.onTokens(function () {});
  window.parley.onState(draw);
  window.parley.ready();
})();
