# Retrospective

A whole ceremony delivered as a plugin: four stages the facilitator steps
through, columns, cards, authorship hidden until the facilitator reveals it (and
hidden again when they say so), grouping, one-dot-per-person voting, a shared
order, stamps, a timer, and action items that remember the cards they came from.

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
  and if the change turns up late the message is taken back. A note waits in
  its lane as a dashed ghost from Enter until the state shows the real one, so
  the box is free for the next thought and nothing is sent twice or dropped.
- **Feature-detect the host.** `session.selfId`, the promise from
  `parley.act`, `parley.supports("results")` and `parley.scheme()` are all used
  when present and never assumed. With `selfId`, only the facilitator is
  offered Reveal; without it, the control is shown with the rule spelled out.
- **One menu holds the long tail.** A note shows one control in front of its
  text and the one the current stage promotes after it. Voting, stamping,
  selecting, moving and starting an action are all in the note's menu, which
  makes the menu the keyboard and touch path for every pointer gesture: a drag
  is never the only way (`openMenu`, `moveNote`, and `Alt`+arrow keys).
- **Optimistic, and taken back.** A move is applied to the board at once and
  sent; if the host refuses, the board is put back (`sendMove`). A stamp is
  dragged locally and sent once, on release.
- **Popovers are one layer.** `openPop` shows one floating thing at a time,
  hangs it from the control that opened it, closes on Escape or a press
  elsewhere, and hands focus back. The board under it is inert while it is
  open. A resize puts it back beside its control and does not close it (a
  phone's keyboard resizes the frame); if a teammate deletes the note it hangs
  from, it closes and says so. At 480px and under every popover is a sheet
  along the bottom edge, at most 70% of the frame high.
- **A drag is followed on the window, and ends once.** `follow()` owns the
  listeners for one gesture and takes them off on release, cancel, Escape, the
  window losing focus or the capture being taken away. State pushes wait while
  a note is carried and are applied when it is put down, also when the note
  itself was deleted meanwhile.
- **State strings never index a plain object.** Ids and kinds come from the
  state, so every map they index is made by `bag()`, which has no inherited
  keys: a note called `constructor` is a note.
- **Motion reports a change and then stops.** A note is set down, a count ticks
  on a spring that runs to rest, notes glide into a new group, and the reveal
  uncovers names across the board once. Nothing moves on first paint, and
  nothing moves under `prefers-reduced-motion`; a new stamp is then marked by a
  ring that is there for a moment and gone, a change of state rather than a
  movement.
- **No forms.** The frame is sandboxed without `allow-forms`, so Enter is a
  `keydown` handler. Changes made by other people are announced through a
  polite live region. The frame has no `h1`: it sits under the host page's
  own, and the lanes and the actions are its `h2`s.

The state carries a vote count per note and nothing about whose votes they
are, so a note is marked as voted only for the rest of the visit in which the
host confirmed the vote. Showing it after a reload would need the plugin to
publish who voted, which it deliberately does not.

Stamps follow the same rule. The state says what each stamp is and where it
sits (`{id, cardId, kind, x, y, rot}`, with `x` and `y` as fractions of the
note so they hold at any width) and never who pressed it. The frame learns
which stamps are the viewer's only from this visit: a stamp that appears
exactly as it was sent, and the server's yes to a change. Only those, and
every stamp for the facilitator, look movable and offer Move. A per-viewer
"mine" flag cannot be published, because the state is one payload for every
viewer. So after a reload a stamp of the viewer's own looks like anybody's: it
can still be removed from its menu ("Remove, if you pressed it"), the server
refuses unless it is theirs, and the board remembers the refusal.

A stamp's `y` runs from 6px above its note's top edge (0) to 16px above the
bottom edge (1), and `x` from the left edge to the right. A stamp can
therefore hang over the top and the sides, into the gutters, and never over
the note underneath; a note with stamps keeps 16px of extra room above it.
The default spot is on the top edge, above the first line of text.

Deleting works the same way as stamps. Before the reveal the state does not
say whose a note is, and what the viewer wrote is not remembered past a
reload, so "Delete note" is offered to everyone and the server answers; hiding
it from non-authors would hide it from the author after a reload. After the
reveal the board does know, and says so without asking. The removal is
announced as "A note was removed from <lane>" and nothing else.

## Actions

| Action | Body | Who |
| --- | --- | --- |
| `add-card` | `{columnId, text}` | anyone |
| `delete-card` | `{cardId}` | whoever wrote it |
| `group-cards` | `{cardIds, title}` | anyone |
| `vote` | `{cardId}` | anyone |
| `move-card` | `{cardId, beforeId?, columnId?, groupId?}` | anyone |
| `move-group` | `{groupId, beforeId?}` | anyone |
| `stamp` | `{cardId, kind, x, y, rot?}` | anyone |
| `move-stamp` | `{stampId, x, y}` | whoever pressed it |
| `remove-stamp` | `{stampId}` | whoever pressed it |
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
validated in `board.js`: ids must exist, text must be text, a stamp's `x` and
`y` must be finite numbers from 0 to 1, a note or a stamp is changed only by
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
| `forbidden` | 403 | somebody else's note or stamp |
| `not-found` | 404 | a note, group, stamp, action item or column the board does not hold |
| `conflict` | 409 | a limit reached; pause, resume or add with no timer set |

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
| Votes | 1,000 | one per note |
| Stamps | 300; 12 per note | 60; 3 per note |
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
| Votes | 1,000 × 41 (`"<user id>":1,`) | 41,000 |
| Stamps | 300 × about 124 | 37,200 |
| Groups | 40 × (240 + about 48) | 11,500 |
| Action items | 30 × (1,500 + 192 + about 130) | 54,700 |
| **Total** | measured by `board.test.mjs` | **339,312** |

That is 32% of the quota: three boards at every limit fit, a fourth does not.
An ordinary board (60 notes of 120 ASCII characters, 100 votes, 40 stamps) is
about 25 KB, so the quota holds some forty of them. The limits bound a board,
not the number of rooms: an org that keeps hundreds of finished retrospectives
will reach the quota, and saving then fails. A group is deleted when its last
note leaves it, and notes and action items can be deleted, so a full board can
be brought back under its limits by the people in the room.

`redactBoard` and `group-cards` build their id lookups once per call. On a
board at every limit a state build takes about 0.05 ms under node, against the
guest's two-second budget (`board.test.mjs` asserts under 200 ms).

A blank owner is nobody. Version 0.1.0 stored the creator's user id when the
owner was left blank; beside a linked note that hints at who wrote the note,
and nobody ever typed it, so an owner that is a bare user id is dropped when
the board is read. A typed name is kept.

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

Switching the install off is host behaviour: the room becomes `kindUnavailable`.
Switching it back on restores the kind. Uninstall is refused while sessions of
`retrospective` still exist. This plugin does not reimplement those.
