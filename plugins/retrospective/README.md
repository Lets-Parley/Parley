# Retrospective

A whole ceremony delivered as a plugin: four stages the facilitator steps
through, columns, cards, authorship hidden until the facilitator reveals it (and
hidden again when they say so), grouping, one-dot-per-person voting, a shared
order, stickers, a timer, and action items that remember the cards they came from.

It does not live in `internal/` or `web/src`. The host already frames an unknown
kind in the full-room slot and exports the guest's `on_session_state` document as
CSV. This package is that guest, plus the iframe UI.

## Build, sign and install

```sh
make test bundle                     # dist/retrospective-0.2.0.parley, unsigned
make bundle KEY=path/to/signing.key  # the same, signed
```

`make bundle` downloads the pinned `extism-js` and Binaryen from
`sdk/plugin-sdk/extism.mk` into `.cache/`, compiles `board.js` + `guest.js` to
`plugin.wasm`, and packs it with `manifest.json` and `ui.js`. Make a key with
`node ../../sdk/plugin-sdk/src/cli.js keygen <prefix>` (or
`parley plugin keygen`); check a bundle with
`parley plugin verify -key "$(cat <prefix>.pub)" dist/retrospective-0.2.0.parley`.

To install, an admin of the default org uploads the `.parley` file on the
**Plugin catalog** page (`/catalog`), then an
org admin installs it from their org's **Plugins** page and accepts the grants.
The server accepts it only if it is signed by a key in `PLUGIN_TRUSTED_KEYS`,
or is unsigned and `PLUGIN_ALLOW_UNSIGNED=true`.

Every Parley release attaches `retrospective-<version>.parley`. When the
project's release key is configured, the bundle is signed with it and the
matching public key is attached beside it as `parley-plugin-signing.pub`.
Before adding that key to `PLUGIN_TRUSTED_KEYS`, check that the key id
`parley plugin verify` prints matches the release key id published out of band:
it will be listed in `SECURITY.md` once a release key exists. A `.pub` on the
same release proves nothing on its own. Without a release key, the bundle is
attached as `retrospective-<version>-UNSIGNED.parley` and the release notes say so.

The grants it asks for:

- `kv` scoped to `board` — one document per session
- `session:read` — so the iframe is allowed to see the envelope
- `session:act` — so the iframe can propose the kind's actions

`make dist` still writes the legacy `PLUGIN_DIR` files,
`dist/retrospective-0.2.0.wasm`, `dist/retrospective-0.2.0.ui.js` and
`dist/retrospective-0.2.0.slots.json`.
`package.json` is a copy of `manifest.json` kept for the host's consent-copy
test; the unit tests fail if the two differ.

## The board UI

`ui.src.js` is the board: plain JavaScript, no build step of its own and no
dependencies. It runs in the host's sandboxed frame and talks only to
`window.parley`. `make` builds `ui.js`, the file the host loads, by putting
`ui.fonts.js` (the embedded typefaces) in front of it; `ui.js` is never edited
and is not tracked, and `dist/retrospective-<version>.ui.js` is the built copy
CI checks. If you are writing your own plugin UI, read `ui.src.js`. These are
the parts worth copying:

- **Build once, then patch.** The shell is created a single time. Each state
  push updates notes, groups and action items by id and leaves every other node
  alone, so a teammate's vote never costs anyone the text they were typing,
  their focus or their place on the page. Nothing is ever written as markup,
  and the state is read through one function that tolerates missing or
  malformed parts.
- **Colors come from the host, everything else is mirrored.** The frame is
  handed sixteen `--color-*` tokens and nothing more. Radii, shadows, type
  sizes, the pill buttons and the focus ring are the values from
  `web/src/tokens.css` written out as literals in the stylesheet at the top of
  `ui.src.js`, with both palettes as the fallback until the tokens arrive.
- **An action is a proposal, and every proposal has an end.** `propose()` is
  the one place the board calls `parley.act`. On a host that reports results it
  acts on the answer at once and puts the reason for a refusal into words. On
  an older host, where `act` returns nothing, it watches the state instead:
  three seconds without the change is reported as unconfirmed, never as lost,
  and if the change turns up late the message is taken back. A yes from the
  host is believed only once the state shows the change, because a host that
  cannot decline answers yes to a request the board declined: whatever was
  drawn ahead of the state (a moved sticker, a moved note) is put back after
  the same three seconds, and a sticker becomes "the viewer's" only when both
  the yes and the state are in. The one exception is a vote: setting a vote to what it already was
  shows nothing new in the state, so there the host's yes is enough. A note waits in
  its lane as a dashed ghost from Enter until the state shows the real one, so
  the box is free for the next thought and nothing is sent twice or dropped.
- **Feature-detect the host.** `session.selfId`, the promise from
  `parley.act`, `parley.supports("results")` and `parley.scheme()` are all used
  when present and never assumed. With `selfId`, only the facilitator is
  offered Reveal; without it, the control is shown with the rule spelled out.
- **One control, one job.** The handle in front of a note drags it and does
  nothing else: pressed without a drag it opens nothing and reads out how a
  move is made. The three dots after the text are the note's menu, in every
  stage and always last on the note's first row. The vote and the action count
  are a row of their own under the words, there only when there is one to
  show, so the words keep the note's width and never break inside a word.
  Editing, adding a sticker, selecting, moving and starting an action are all
  in that menu, which makes it the keyboard and touch path for every pointer
  gesture: a drag is never the only way (`openMenu`, `moveNote`, `toLane`, and
  `Alt`+arrow keys, Left and Right for the next lane). Voting is not in it:
  the thumbs are on the note, and `U` and `D` are the keys. Groups have the
  same pair in their heading.
- **The menu is short, and never leaves the frame.** A note's menu
  (`noteRows`) is a title, "Edit note…" (`E`), "Add a sticker…" (`S`; with
  stickers on the note it reads "Stickers (3)…" and opens the list, which also
  adds one), "Start an action…", "Select to group" where the checkbox is not
  showing, a **Reorder** strip of four buttons (to top, up, down, to bottom),
  **Move to…**, and "Delete note…" alone under a rule. The strip's buttons
  keep the menu open, so a note can be walked up a lane, and each sends what
  `Alt` and an arrow sends. "Move to…" is one step in, under a Back row: out
  of the note's group, the other lanes, the other groups. A group's menu is
  "Start an action…", the strip and "Move to…"; an action's is its owner and
  "Delete action…". A row that cannot be used says why under itself. Keys:
  Up and Down between rows (the strip is one row), Left and Right along the
  strip, Right or Enter into "Move to…", Left or Escape back out, Home and
  End, a letter for the next item that starts with it, Escape to close, Tab
  to close and move on. `placePop` hangs a menu from the right edge of its
  button, under it; above it when there is no room below; and otherwise as
  low as it fits, scrolling inside itself only in a frame shorter than the
  menu. The rows are asked for again whenever the board changes, so an open
  menu keeps up with it.
- **Tab order on a note** follows what is seen, row by row: the handle, the
  checkbox while notes are being picked, the words, the three dots, then the
  row under the words (the action count and the thumbs), then the stickers
  (one stop for the pile) and the dashed plus. The three dots are the last
  stop of the note's first row, not of the note.
- **A drop aims at one of three things** (`aimAt`): a place in a lane, which
  may be another lane; a group, which the note joins where it is dropped; or a
  loose note in the same lane, which it is grouped with. The middle half of a
  note means "group with this" only after the pointer has rested there for
  300ms, and is then kept until the pointer is nearly off the note
  (`zoneOf`); the quarters above and below mean before and after. Grouping by
  drop asks for the group's name first and sends nothing until it has one,
  because a group cannot be renamed. Every drop sends exactly the body the
  menu sends for the same move. A lane sorted by "Top rated" takes a note
  from another lane at its end and takes no positions; a whole group is
  carried by the handle in its heading. A group left with one note stays a
  group; an empty one is removed.
- **Optimistic, and taken back.** A move is applied to the board at once and
  sent; if the host refuses, the board is put back (`sendMove`). A sticker
  is dragged locally and sent once, on release.
- **Popovers are one layer.** `openPop` shows one floating thing at a time,
  hangs it from the control that opened it, closes on Escape or a press
  elsewhere, and hands focus back. The board under it is inert while it is
  open. A resize puts it back beside its control and does not close it (a
  phone's keyboard resizes the frame); if a teammate deletes the note it hangs
  from, it closes, says so, and puts focus on the note in its place. Tab and
  Shift+Tab go round inside a sheet (a menu closes on Tab). At 480px and under
  every popover is a sheet along the bottom edge, at most 70% of the frame
  high; there a menu is a sheet too, over a scrim, with rows 48px high, a
  visible Done, and Tab kept inside it.
- **A drag is followed on the window, and ends once.** `follow()` owns the
  listeners for one gesture and one pointer, and takes them off on release,
  cancel, Escape, the window losing focus or the capture being taken away. A
  second finger's events are not that pointer's and are ignored. State pushes wait while
  a note is carried and are applied when it is put down, also when the note
  itself was deleted meanwhile.
  A press while a gesture is still open means its release was never heard:
  that gesture is ended first, and every ending gives the pointer capture
  back. Held at the edge of what is in sight, the page keeps scrolling: the
  frame may be as tall as the board, so it learns what is in sight from an
  `IntersectionObserver` and asks for a spot just past that edge.
- **State strings never index a plain object.** Ids and kinds come from the
  state, so every map they index is made by `bag()`, which has no inherited
  keys: a note called `constructor` is a note.
- **Motion reports a change and then stops.** A note is set down, a count ticks
  on a spring that runs to rest, notes glide into a new group, and the reveal
  uncovers names across the board once. Nothing moves on first paint, and
  nothing moves under `prefers-reduced-motion`; a new sticker is then simply
  there, and is announced like any other.
- **No forms.** The frame is sandboxed without `allow-forms`, so Enter is a
  `keydown` handler. Changes made by other people are announced through a
  polite live region. The frame has no `h1`: it sits under the host page's
  own, and the lanes and the actions are its `h2`s.

Voting is a thumb up and a thumb down on every note: one vote per person per
note, up, down or none. The state carries the two counts per note (`up`,
`down`) and nothing about whose votes they are, so a thumb is shown as the
viewer's only for the rest of the visit in which the host confirmed it.
Showing it after a reload would need the plugin to publish who voted, which it
deliberately does not.

That is why `vote` **sets** a vote and never flips one. After a reload the
board cannot tell someone which thumb is theirs; with a toggle, pressing the
thumb they already hold would silently take their vote away. With a set, the
same press asks for what they already have, the server takes it and changes
nothing, and the yes tells the board the thumb is theirs. The rule on the
board: a thumb known to be yours, pressed again, takes the vote back (`none`);
the other thumb switches in one press; a thumb not known to be yours is set.

The thumbs are on every note in the Vote stage, and in the other stages only
on a note that has votes, so a note with nothing on it stays one row. "Top
rated" (a lens for one reader) and the facilitator's order-for-everyone rank by
ups less downs, then by more ups, then leave the order as it was. A group's
heading says its ups and downs. Other people's votes are not read out as they
arrive (in the Vote stage that would be the whole room at once): each thumb
carries both counts in its name, and a person hears the outcome of their own
vote. `U` and `D` on a note's words vote up and down. A second press of the
same thumb within 400ms is taken as part of the first, so a double click does
not set a vote and take it back. A thumb says whether it is pressed only when
that is known; after a reload it says neither.

A note's words can be edited by whoever wrote it, and by nobody else: there is
no facilitator's way in. "Edit note" in the menu, `E` or `F2` on the note's
words, or a double click on them turns them into a box in place, with Save and
Cancel in a row of the note's own under it; Enter saves, Shift+Enter is a new
line, Escape cancels. Leaving with changed words asks once ("Discard
changes?"), and while a save is out the editor cannot be left. The note keeps its place, group,
votes, stickers and links. Because votes cast on the old words now sit on the
new ones, an edited note is published with `edited: true` and says "edited";
who edited is never published (it is the author, who is published only while
authors are revealed). Edits are allowed in every stage. As with Delete, the
board does not know whose a note is before the reveal, so Edit is offered to
everyone, the server answers, and a refusal is remembered for the visit. A
teammate's change never touches a draft; if the note is deleted while it is
being edited, the words typed go to its lane's box for a new note.

Stickers follow the same rule. There are fourteen: seven meanings (Me too,
Thank you, Great idea, Quick win, Needs a chat, Blocker, Made me laugh), each
as a vinyl sticker and as pixel art, and the two sets mix freely on a note.
The state says what each sticker is and where it sits (`{id, cardId, kind, x,
y, rot}`, with `x` and `y` as fractions of the note so they hold at any width)
and never who placed it. The frame learns which stickers are the viewer's only
from this visit: one that appears exactly as it was sent, and the server's yes
to a change. Only those, and every sticker for the facilitator, look movable
and offer Move and Bring to front. A per-viewer "mine" flag cannot be
published, because the state is one payload for every viewer. So after a
reload a sticker of the viewer's own looks like anybody's: it can still be
removed from its menu ("Remove, if you placed it"), the server refuses unless
it is theirs, and the board remembers the refusal.

The interface says "sticker" everywhere. The actions and the stored field
keep the name they shipped with (`stamp`, `move-stamp`, `remove-stamp`,
`moderate-stamp`, `stamps`): renaming them would change the manifest and every
stored board for nothing a person can see. The seven kind ids boards already
hold (`me-too`, `thanks`, `idea`, `quick-win`, `chat`, `blocker`, `laugh`) are
the vinyl set, and the pixel set is the same ids with `p-` in front, so no
stored board needs migrating.

Placement is free. A sticker's center may be anywhere from 8px inside its
note's left and right edges (`x` 0 and 1) to 4px outside its top and bottom
edges (`y` 0 and 1). A sticker is 42px across, so it hangs at most 15px over a
side, inside the lane's padding, and 27px over the top or bottom, inside the
26px gap notes keep everywhere (under a group's heading and under the composer
too): nothing moves when a first sticker lands or a last one leaves, and a
note is given no class or style for having stickers. Picked from the book, a
sticker lands on no word: the note's lines are measured, and of the corner
under the handle, the handle's column and the bottom edge, only places where
the sticker would cover no word are used. When every one is taken the next
stickers pile where the first went, on each other and still off the words.
Only a sticker somebody drags can lie on the words. The dashed plus stands at
the far end of the note's foot, clear of stickers, words and controls, and is
not shown when there is no such place or the note or the viewer is at a cap.

The vinyl set keeps the small tilt it was placed with. A pixel sticker is
never tilted (the stored `rot` is ignored for the `p-` kinds) and is sized so
that each of its fourteen cells is a whole number of device pixels at the
current zoom, so no cell is uneven. A sticker of a kind this version does not
know, from a newer one, is drawn as a plain sticker named "Sticker": it still
counts against the caps, and whoever placed it can remove it. A removed
sticker peels off (271ms); a teammate's only lifts away. When its placer sets a pixel sticker down, four of its cells are
kicked up as dust at the moment of contact and are gone within a third of a
second; a teammate's pixel sticker, and every vinyl one, lands without.

The book says "N of 3 left on this note" only when it can know: when every
sticker on the note arrived during this visit. Otherwise it says "Up to 3 of
yours on a note" and leaves the count to the server, whose refusal is put in
words.

Stickers pile in the order they land. The order of `stamps` in the state is
the pile, bottom to top: placing appends, and `move-stamp` (and a
`moderate-stamp` that moves) puts the row back at the end, so what is picked
up goes back down on top and "Bring to front" is a move to where the sticker
already is. Nothing is grouped, counted or spread out. The topmost sticker is
the one a pointer hits; one underneath is reached with Page Up and Page Down
from a focused sticker, or from "Stickers (n)…" in the note's menu. A
note's controls are drawn above every sticker and stay clickable. Stickers
lying over a note's words go faint while the words are pointed at, while one
of the note's controls has keyboard focus, or after a tap on the words.

Keys. A note's single-letter keys (`S`, `E`, `F2`, `U`, `D`) are heard only
with focus on the note's words, which are a Tab stop: never from a button or a
box being typed in, and never while the note is being edited, so typing "due"
cannot vote or edit. On a note's words, `S` opens the sticker book. In the book, `1` to `7` place
from the marked sheet, `V` and `P` (or Up, Down and Tab) change sheets, Left
and Right go along a sheet, and Escape closes it. On a sticker, the arrow keys
move it 6px (24px with Shift), Page Up and Page Down go up and down the pile,
Home and End go to its bottom and top, `F` brings it to the front, Delete
removes it and Enter opens its menu. An earlier draft of this board used Left
and Right to step between stamps and Shift with an arrow to move one; that was
never released, and stepping left and right means nothing in a pile.

Deleting works the same way as stickers. Before the reveal the state does not
say whose a note is, and what the viewer wrote is not remembered past a
reload, so "Delete note" is offered to everyone and the server answers; hiding
it from non-authors would hide it from the author after a reload. After the
reveal the board does know, and says so without asking. The removal is
announced as "A note was removed from <lane>" and nothing else. A refusal is
remembered for the visit, and Delete for that note is then shown as
unavailable with the same reason.

Anonymity before the reveal means that nobody else can see who wrote a note.
It does not mean the server pretends not to know: when you try to delete a
note that is not yours, it tells you so.

## Actions

| Action | Body | Who |
| --- | --- | --- |
| `add-card` | `{columnId, text}` | anyone |
| `delete-card` | `{cardId}` | whoever wrote it |
| `group-cards` | `{cardIds, title}` | anyone |
| `edit-card` | `{cardId, text}`; text as for `add-card`; the same text again is accepted and marks nothing | whoever wrote it |
| `vote` | `{cardId, value}` with `value` `up`, `down` or `none`; sets, never toggles; without `value` it is `up` | anyone |
| `move-card` | `{cardId, beforeId?, columnId?, groupId?}`; a `groupId` with a `columnId` the group is not in is `invalid` | anyone |
| `move-group` | `{groupId, beforeId?, columnId?}` | anyone |
| `stamp` (place a sticker) | `{cardId, kind, x, y, rot?}`; `kind` is one of the fourteen ids | anyone |
| `move-stamp` | `{stampId, x, y}`; also puts it on top of its pile | whoever placed it |
| `remove-stamp` | `{stampId}` | whoever placed it |
| `add-action` | `{text, owner?, sourceIds?}` | anyone |
| `set-owner` | `{actionId, owner?}`; blank means unassigned | anyone |
| `delete-action` | `{actionId}` | anyone |
| `link-action` | `{actionId, sourceId, linked}` | anyone |
| `reveal`, `conceal` | `{}` | facilitator |
| `set-stage` | `{stage}` (0 to 3) | facilitator |
| `timer` | `{op, durationMs?}`; `op` is `start`, `pause`, `resume`, `add` or `clear` | facilitator |
| `order-by-votes` | `{columnId}` | facilitator |
| `moderate-stamp` | `{stampId, x, y}` or `{stampId, remove: true}` | facilitator |
| `moderate-card` | `{cardId}` | facilitator |

`beforeId` names a card or a group to sit in front of; without one, or with one
that is gone, the move goes to the end. Nothing is addressed by index, because
the board is one document and the last write wins.

The host enforces `facilitatorOnly` from `manifest.json` before the guest is
called, and the guest is never told who the facilitator is, so the manifest is
the whole of that check (`package.test.mjs` pins the list). Everything else is
validated in `board.js`: ids must exist, text must be text, a sticker's `x` and
`y` must be finite numbers from 0 to 1, a note or a sticker is changed only by
whoever made it, and the limits below hold. `redactBoard` is the only thing
that decides what leaves the server.

### Declining, not failing

A request the board will not take is **declined**: `on_session_action` answers
`{"refused":"<code>"}` and saves nothing. A host that reads the answer (the
protocol is a host change of its own) answers the caller with the matching
status, broadcasts nothing, and does not count it against the plugin. An
accepted action answers `{}`.

| Code | Status | When |
| --- | --- | --- |
| `invalid` | 400 | empty, non-text or too-long text; a bad coordinate, stage, timer operation or duration; fewer than two notes to group; an unknown action |
| `forbidden` | 403 | somebody else's note or sticker |
| `not-found` | 404 | a note, group, sticker, action item or column the board does not hold |
| `conflict` | 409 | a limit reached; pause, resume or add with no timer set; the org's plugin storage is full |

The guest throws only for a real fault: a stored document it cannot read, a
host function that fails, a missing clock. Before this, every one of the above
was thrown, which the host counts as a plugin failure, so any participant could
get the install disabled by sending nonsense.

The codes are the host's own, so the frame cannot tell a full board from an
ended room by the code alone; each `propose()` call brings its own words for
the codes the board can answer with. On a host that does not yet read the
answer, a declined request is treated as accepted and changes nothing; the
frame then hears "yes" and sees no change.

### Limits

Every board of an org is a key in one store with one quota: `quotaBytes`,
1,048,576, shared by every room. `LIMITS` in `board.js` bounds one board:

| | Per board | Per person |
| --- | --- | --- |
| Notes, 500 characters each | 120 | 30 |
| Groups, title 80 characters | 40 | |
| Notes named in one `group-cards` | 50 | |
| Votes, up or down | 1,000 | one per note |
| Stickers | 300; 12 per note | 60; 3 per note |
| Action items, text 500 and owner 64 characters | 30 | |
| Links per action | 12 | |

A retro of twelve people writing ten notes each fills the note limit; nothing
smaller reaches any of them. Text is counted in UTF-16 units after control
characters and unpaired surrogates are stripped (JSON writes each of those as
six bytes), which leaves three bytes per unit as the worst case. The largest
document these allow, stored as JSON with 36-character user ids:

| Part | Arithmetic | Bytes |
| --- | --- | --- |
| Note text | 120 × 500 × 3 | 180,000 |
| Note structure | 120 × about 120 | 14,600 |
| Votes | 1,000 × 42 (`"<user id>":-1,`) | 42,000 |
| Stickers | 300 × about 124 | 37,200 |
| Groups | 40 × (240 + about 48) | 11,500 |
| Action items | 30 × (1,500 + 192 + about 130) | 54,700 |
| **Total** | measured by `board.test.mjs` | **339,312** |

(Measured with every vote up and no note edited; down votes and edited marks
add about 3,000 bytes.) That is 32% of the quota: three boards at every limit fit, a fourth does not.
An ordinary board (60 notes of 120 ASCII characters, 100 votes, 40 stickers) is
about 25 KB, so the quota holds some forty of them. The limits bound a board,
not the number of rooms: an org that keeps hundreds of finished retrospectives
will reach the quota. A full store declines every write that grows a board
(`conflict`; `guest.js` reads the host function's quota error and answers
with it rather than failing), and still takes one that shrinks it, so deleting
notes or action items is the way out, as is an admin removing old rooms. The
frame cannot tell a full store from a full board by the code, so its messages
for `conflict` name both. A group is deleted when its last
note leaves it, and notes and action items can be deleted, so a full board can
be brought back under its limits by the people in the room.

`redactBoard` and `group-cards` build their id lookups once per call. On a
board at every limit a state build takes about 0.05 ms under node, against the
guest's two-second budget (`board.test.mjs` asserts under 200 ms).

A blank owner is nobody. Version 0.1.0 stored the creator's user id when the
owner was left blank; beside a linked note that hints at who wrote the note,
and nobody ever typed it, so an owner that is a bare user id is dropped when
the board is read. A typed name is kept. For the same reason an owner that is
a bare user id is declined as `invalid` by `add-action` and `set-owner`, so
one can never be stored or published.

The timer is stamped by the server: the guest reads its own clock
(`Date.now()`, which the host provides as wall time) and publishes the time
remaining with each state, so the frame never compares its clock with the
server's. The frame counts down from there and reads the timer again only when
its `rev` changes.

Adding actions does not change the grants. The host decides whether an upgrade
needs a new consent from the capabilities alone, so 0.1.0 to 0.2.0 applies
without one.

`slots.json` is `["room"]`: the board is the room of a retrospective session and
is not offered as a side panel in other rooms.

### Fonts

`ui.fonts.js` embeds Instrument Sans and JetBrains Mono (latin subset) as
`data:` URIs, the only font source the frame's policy allows. Both are licensed
under the SIL Open Font License 1.1. The copyright notices and the full license
text are in the header comment of `ui.fonts.js`, so they travel inside `ui.js`
in every bundle; `OFL.txt` holds the same text as a file for anyone reading the
repository. A `.parley` bundle holds exactly `manifest.json`, `plugin.wasm`,
`ui.js` and `slots.json` and refuses any other file, which is why the license
rides in the script rather than beside it.

## Storage (open question 2)

The host key-value store has get and set, not list or prefix scan. Grouping and
dot-voting therefore live on **one namespaced document** per session (`scope=board`,
`key=<session id>`). `on_session_state` reads that document; `on_session_action`
reads, mutates, writes. Concurrent writes are last-write-wins. Compare-and-swap
is still the right next step before #22 freezes the wire protocol; it is not
required to express the board.

## Disable and uninstall

Switching the install off is host behavior: the room becomes `kindUnavailable`.
Switching it back on restores the kind. Uninstall is refused while sessions of
`retrospective` still exist. This plugin does not reimplement those.
