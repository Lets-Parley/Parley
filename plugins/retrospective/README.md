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

`make dist` also writes the legacy `PLUGIN_DIR` files,
`dist/retrospective-0.2.0.wasm`, `dist/retrospective-0.2.0.ui.js` and
`dist/retrospective-0.2.0.slots.json`. The `.wasm` is build output and is not
tracked.
`package.json` is a copy of `manifest.json` kept for the host's consent-copy
test; the unit tests fail if the two differ.

## The board UI

`ui/` is the board: plain JavaScript in ES modules, one concern to a file, no
dependencies and no bundler. It runs in the host's sandboxed frame and talks to
nothing but `window.parley`. If you are writing your own plugin UI, this is the
folder to read; the files named below are where each idea lives, and each
folder's own README says what belongs in it.

| Folder | What is in it |
| --- | --- |
| `ui/main.js` | the shell: builds the page once, wires the listeners, boots |
| `ui/bridge/` | `window.parley`, the state as the board reads it, and every action it proposes |
| `ui/components/` | one piece of the page each: lane, note, group, menu, sticker book, timer, stage bar, action list, notices |
| `ui/features/` | behavior that spans components: composing, voting, editing, moves, drag, sticker placement, patching |
| `ui/styles/` | the stylesheet as strings, one part per component, and the color tokens |
| `ui/utils/` | DOM, text and motion helpers with no board knowledge |
| `ui/constants/` | limits, lanes, stages and the words for refusals |
| `ui/assets/` | icon paths and sticker art; the fonts stay in `ui.fonts.js` |

### Building and testing it

The modules import and export so an editor can follow a name between files,
but nothing loads them as modules. `make` joins them, in the order `UI_SRC` in
the `Makefile` lists, into one function scope (`ui-join.awk` drops each file's
leading imports and every `export `), which is `ui.board.js`; then it builds
`ui.js`, the file the host loads, as `cat ui.fonts.js ui.board.js`: the embedded
typefaces first, then the board. The order is the order the top-level code
runs in, and the build fails if a file under `ui/` is not listed or a listed
file is missing. Because it is one scope, a few board-wide `let`s (`board`,
`session`, `drag`, …) are assigned from more than one file; a real module
loader would refuse that, which is one more reason the files are joined, not
loaded. `ui.js` and `ui.board.js` are never edited and are not tracked. `dist/retrospective-<version>.ui.js` and
`dist/retrospective-<version>.slots.json` are committed because CI rebuilds
them and fails on any diff, which proves the committed bundle inputs match the
source.

`make test` runs `board.test.mjs`, `guest.test.mjs`, `ui.test.mjs` and
`package.test.mjs` under Node's test runner, with a heap and address-space cap
so a runaway test fails instead of taking the machine with it. Run them through
`make`, not with `node --test` directly. `ui.test.mjs` drives `ui.board.js`
against a fake `window.parley` and checks the built copy in `dist/`; the detailed behavior of notes,
votes, stickers, menus and drag is pinned there rather than in this README.

### Talking to the host

The frame's whole interface is `window.parley`:

- **`parley.onState(fn)`** delivers the room envelope: the kind's redacted
  state from `on_session_state`, plus `participants`, `facilitatorId` and, on
  hosts that send it, `selfId`. See `ui/bridge/state.js` and `ui/components/people.js`.
- **`parley.act(action, payload)`** proposes one of the actions in the table
  below. Every call goes through `propose()` in `ui/bridge/actions.js`. On a host
  that reports results, `act` returns a promise of the outcome, and a refusal
  arrives with its code so the board can put the reason into words. On an older
  host it returns nothing, and the board watches the state instead: three
  seconds without the change is reported as unconfirmed, and a change that
  turns up late takes the message back. `parley.supports("results")` is the
  documented way to ask up front; the board just checks whether `act` returned
  a promise.
- **`session.selfId`** says who is looking. `viewerRole()` treats a missing
  `selfId` as "unknown", never as "nobody": with it, only the facilitator is
  offered facilitator controls; without it, they are shown and the host's
  refusal is put into words.
- **Theme tokens.** `parley.onTokens(fn)` hands the frame the host's
  `--color-*` tokens, and `parley.scheme()` says whether they are light or
  dark. Only colors come from the host. Radii, shadows and type sizes are the
  values from `web/src/tokens.css` written out in `ui/styles/tokens.js`, with both
  palettes as the fallback until the tokens arrive. `applyScheme` in
  `ui/main.js` falls back to the surface token's luminance on a host that
  sends no scheme.
- **`parley.ready()`** is called last, once the shell is built and both
  listeners are attached.

Feature-detect each of these; never assume them.

### Patterns worth copying

- **Build once, then patch** (`ui/main.js`, `ui/components/note.js`,
  `ui/components/group.js`, `ui/components/action-list.js`). The shell is created a single time, and
  each state push updates notes, groups and action items by id, so a
  teammate's vote never costs anyone their focus or a half-typed sentence.
  Nothing is written as markup.
- **Read the state through one tolerant function** (`ui/bridge/state.js`). Missing
  or malformed parts degrade to empty, and every map indexed by an id from the
  state is made by `bag()`, which has no inherited keys: a note called
  `constructor` is just a note.
- **Optimistic, and taken back** (`ui/features/moves.js`). A move is drawn at once
  and sent; if the host refuses, `sendMove` puts it back. A drag sends exactly
  the body the keyboard and menu path sends for the same move.
- **Every pointer gesture has a keyboard and touch path** (`ui/components/popover.js`,
  `ui/components/menu.js`, `ui/features/drag.js`). The note's menu (`openMenu`) and `Alt`+arrow keys cover
  every drag. `openPop` keeps one popover at a time and returns focus to its
  control; `follow()` owns one gesture's listeners and always releases them.
- **No forms.** The frame is sandboxed without `allow-forms`, so Enter is a
  `keydown` handler. Changes by other people go to a polite live region
  (`ui/components/notices.js`).
- **Motion reports a change and stops** (`ui/utils/motion.js`). Nothing moves on
  first paint or under `prefers-reduced-motion`.

### What the state does not say

The state is one payload for every viewer, so it never says who voted, who
placed a sticker, or (before the reveal) who wrote a note. The board learns
"mine" only from what the host confirmed during this visit. That is why `vote`
**sets** a vote rather than toggling it: after a reload the board cannot tell
which thumb is yours, and a toggle would silently take a vote away. Delete,
edit and sticker removal are offered to everyone before the reveal; the server
answers, and the board remembers a refusal for the rest of the visit.

The interface says "sticker"; the actions and the stored field keep the names
they shipped with (`stamp`, `move-stamp`, `remove-stamp`, `moderate-stamp`,
`stamps`), because renaming them would change the manifest and every stored
board. The pixel stickers are the vinyl kind ids with `p-` in front, so no
stored board needs migrating.

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
`{"refused":"<code>"}` and saves nothing. The host answers the caller with the
matching status, broadcasts nothing, and does not count it against the plugin.
An accepted action answers `{}`.

| Code | Status | When |
| --- | --- | --- |
| `invalid` | 400 | empty, non-text or too-long text; a bad coordinate, stage, timer operation or duration; fewer than two notes to group; an unknown action |
| `forbidden` | 403 | somebody else's note or sticker |
| `not-found` | 404 | a note, group, sticker, action item or column the board does not hold |
| `conflict` | 409 | a limit reached; pause, resume or add with no timer set; the org's plugin storage is full |

The guest throws only for a real fault: a stored document it cannot read, a
host function that fails, a missing clock. A thrown error is counted as a
plugin failure, so declining instead of throwing is what keeps a participant
from getting the install disabled by sending nonsense.

The codes are the host's own, so the frame cannot tell a full board from an
ended room by the code alone; each `propose()` call brings its own words for
the codes the board can answer with.

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

## Storage

The host key-value store has get and set, not list or prefix scan, so the whole
board is **one namespaced document** per session (`scope=board`,
`key=<session id>`). `on_session_state` reads that document; `on_session_action`
reads, mutates and writes it. Concurrent writes are last write wins: the store
has no compare-and-swap yet.

## Disable and uninstall

Switching the install off is host behavior: the room becomes `kindUnavailable`.
Switching it back on restores the kind. Uninstall is refused while sessions of
`retrospective` still exist. This plugin does not reimplement those.
