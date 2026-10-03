import { bag } from "../utils/bag.js";
import { GLYPH } from "../assets/glyphs.js";
import { ONLY_AUTHOR, ONLY_AUTHOR_EDITS } from "../constants/board.js";
import { short } from "../utils/text.js";
import {
  actionsFrom, cardById, columnTitle, groupById, ui, view,
} from "../bridge/state.js";
import { viewerRole } from "./people.js";
import { openConfirm, openMenu } from "./menu.js";
import { SORTED_OFF } from "./lane.js";
import { leadOf } from "./note.js";
import { deleteNote, editNote, notMineNote } from "../features/editing.js";
import { moveNote, placeSaid, sendMove, toLane } from "../features/moves.js";
import { pileOf } from "../features/sticker-layout.js";
import { openStamps } from "./sticker-book.js";
import { openStampList } from "./sticker-list.js";
import { patchSelection } from "./selection-bar.js";
import { openLinks } from "./links.js";

export const notMyNotes = bag();

// The four ways a thing goes up and down its lane: the strip in a menu,
// and the keys that do the same.
const WAYS = [["top", "Move to top", "Alt+Shift+Up"], ["up", "Move up", "Alt+Up"], ["down", "Move down", "Alt+Down"], ["bottom", "Move to bottom", "Alt+Shift+Down"]];

export function reorderStrip(off, word, move) {
  return {
    strip: "Reorder",
    keys: "Alt+arrows",
    off: off,
    items: WAYS.map(function (way) {
      return {
        label: way[1].replace("Move", word),
        icon: GLYPH[way[0]],
        keys: way[2],
        run: function () {
          move(way[0]);
        },
      };
    }),
  };
}

// Voting is not here: the thumbs are on the note, and U and D are the keys.
function noteRows(id, opener) {
  const card = cardById(id);
  const note = view.notes[id];
  if (!card || !note) return [];
  const off = view.lanes[card.columnId].sorted ? SORTED_OFF : "";
  const linked = actionsFrom(id).length;
  const pressed = pileOf(id).length;
  const rows = [
    {
      label: "Edit note…",
      icon: GLYPH.edit,
      keys: "E",
      off: notMineNote(id) ? ONLY_AUTHOR_EDITS : "",
      run: function () {
        editNote(id);
      },
    },
    // With stickers on the note, the row opens the list of them, which
    // also adds one; S opens the book either way.
    pressed
      ? {
          label: "Stickers (" + pressed + ")…",
          icon: GLYPH.sticker,
          run: function () {
            openStampList(id, opener);
          },
        }
      : {
          label: "Add a sticker…",
          icon: GLYPH.sticker,
          keys: "S",
          run: function () {
            openStamps(id, opener);
          },
        },
    {
      label: linked ? "Actions from this note (" + linked + ")…" : "Start an action…",
      icon: GLYPH.target,
      run: function () {
        openLinks(id, opener);
      },
    },
  ];
  // Where the checkbox is showing, it is the way to select.
  if (note.pick.hidden) {
    rows.push({
      label: "Select to group",
      icon: GLYPH.select,
      run: function () {
        ui.selected[id] = true;
        patchSelection();
        leadOf(note).focus();
      },
    });
  }
  rows.push(
    { sep: true },
    reorderStrip(off, "Move", function (way) {
      moveNote(id, way);
    }),
  );
  // Everywhere else the note can go, one step in: out of its group, the
  // other lanes, the other groups.
  const places = [];
  const group = card.groupId && groupById(card.groupId);
  if (group) {
    places.push(
      {
        label: "Out of “" + group.title + "”",
        icon: GLYPH.out,
        off: off,
        run: function () {
          sendMove("move-card", { cardId: id, groupId: null }, "Taken out of its group.");
        },
      },
      { sep: true },
    );
  }
  ui.board.columns.forEach(function (col) {
    if (col.id === card.columnId) return;
    places.push({
      label: col.title,
      kind: "lane",
      run: function () {
        toLane("note", id, col.id);
      },
    });
  });
  places.push({ sep: true });
  ui.board.groups.forEach(function (g) {
    if (g.id === card.groupId) return;
    places.push({
      label: g.title,
      kind: g.columnId === card.columnId ? "group" : "group in " + columnTitle(g.columnId),
      run: function () {
        sendMove("move-card", { cardId: id, groupId: g.id }, function () {
          return placeSaid("note", id);
        });
      },
    });
  });
  if (places.some(function (row) { return !row.sep; })) {
    rows.push({
      label: "Move to…",
      title: "Move to",
      icon: GLYPH.move,
      sub: function () {
        return places;
      },
    });
  }
  // Before the reveal nothing says whose a note is, and what this viewer
  // wrote is not remembered past a reload, so Delete is offered to everyone
  // and the server answers. After the reveal the board does know.
  // A note the server has already said is somebody else's stays that way
  // for the visit.
  const others = (viewerRole() !== "facilitator" && notMyNotes[id]) || (ui.board.revealed && card.authorId && viewerRole() === "participant" && card.authorId !== ui.session.selfId);
  rows.push(
    { sep: true },
    {
      label: "Delete note…",
      icon: GLYPH.trash,
      danger: true,
      off: others ? ONLY_AUTHOR : "",
      run: function () {
        openConfirm(opener, "Delete this note?", "Its votes, stickers and links to actions go with it. This cannot be undone.", "Delete note", function () {
          deleteNote(id);
        });
      },
    },
  );
  return rows;
}

export function openNoteMenu(id, opener) {
  openMenu(
    opener,
    "Options for note: " + short(cardById(id).text),
    function () {
      return noteRows(id, opener);
    },
    function () {
      const card = cardById(id);
      return card ? card.text : "";
    },
  );
}

