# Retrospective

A whole ceremony delivered as a plugin: columns, cards, hidden authorship until
the facilitator reveals, grouping, one-dot-per-person voting, and action items.

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

`ui.js` is plain JavaScript with no build step and no dependencies. It runs in
the host's sandboxed frame and talks only to `window.parley`. If you are writing
your own plugin UI, these are the parts worth copying:

- **Build once, then patch.** The shell is created a single time. Each state
  push updates notes, groups and action items by id and leaves every other node
  alone, so a teammate's vote never costs anyone the text they were typing,
  their focus or their place on the page. Nothing is ever written as markup.
- **Colors come from the host, everything else is mirrored.** The frame is
  handed sixteen `--color-*` tokens and nothing more. Radii, shadows, type
  sizes, the pill buttons and the focus ring are the values from
  `web/src/tokens.css` written out as literals in the stylesheet at the top of
  `ui.js`, with both palettes as the fallback until the tokens arrive. The two
  typefaces are embedded as `data:` URIs, the only font source the frame's
  policy allows.
- **An action is a proposal.** `parley.act` returns nothing, so the UI checks
  what `board.js` would refuse before sending (an empty note, a group of fewer
  than two notes or of notes from two lanes), keeps typed text until the state
  shows it landed, and says so in words if it never does. Revealing authors is
  the facilitator's alone: the server enforces that, and the UI explains it.
- **Motion reports a change and then stops.** A note is set down, a count ticks
  on a spring that runs to rest, notes glide into a new group, and the reveal
  uncovers names across the board once. Nothing moves on first paint, and
  nothing moves under `prefers-reduced-motion`.
- **No forms.** The frame is sandboxed without `allow-forms`, so Enter is a
  `keydown` handler. Changes made by other people are announced through a
  polite live region.

`slots.json` is `["room"]`: the board is the room of a retrospective session and
is not offered as a side panel in other rooms.

Instrument Sans and JetBrains Mono are embedded under the SIL Open Font License
1.1.

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
