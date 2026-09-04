# Retrospective

A whole ceremony delivered as a plugin: columns, cards, hidden authorship until
the facilitator reveals, grouping, one-dot-per-person voting, and action items.

It does not live in `internal/` or `web/src`. The host already frames an unknown
kind in the full-room slot and exports the guest's `on_session_state` document as
CSV. This package is that guest, plus the iframe UI.

## What to put in `PLUGIN_DIR`

After `make dist`:

- `dist/retrospective-0.1.0.wasm`
- `dist/retrospective-0.1.0.ui.js`

Copy those two files into the directory `PLUGIN_DIR` points at. Names are
load-bearing: the host looks up `<name>-<version>.wasm` and `<name>-<version>.ui.js`.

## Install

Upload `package.json` as the install package (`manifest` 1, `kind` `"plugin"`)
and accept the grants. It asks for:

- `kv` scoped to `board` — one document per session
- `session:read` — so the iframe is allowed to see the envelope
- `session:act` — so the iframe can propose the kind's actions

## Storage (open question 2)

The host key-value store has get and set, not list or prefix scan. Grouping and
dot-voting therefore live on **one namespaced document** per session (`scope=board`,
`key=<session id>`). `on_session_state` reads that document; `on_session_action`
reads, mutates, writes. Concurrent writes are last-write-wins. Compare-and-swap
is still the right next step before #22 freezes the wire protocol; it is not
required to express the board.

## Build

`make dist` downloads a pinned `extism-js` (`v1.7.0`) and Binaryen (`wasm-merge`)
into `.cache/` and compiles `board.js` + `guest.js` to Wasm. `make test` is
`node --test` on the files next to this README. Python is not an Extism guest
PDK; this guest is JavaScript.

## Disable and uninstall

Switching the install off is host behaviour: the room becomes `kindUnavailable`.
Switching it back on restores the kind. Uninstall is refused while sessions of
`retrospective` still exist. This plugin does not reimplement those.
