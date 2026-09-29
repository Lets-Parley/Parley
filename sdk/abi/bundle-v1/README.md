# bundle-v1 golden vectors

**`TEST-ONLY-signing.key` is a published test key (seed bytes 0x00..0x1f). Never
trust it on a real instance.** Its public half is `TEST-ONLY-signing.pub`.

Packing `input/manifest.json`, `input/plugin.wasm`, `input/ui.js` and
`input/slots.json` with that key must produce `expected.parley` exactly, whose
digest is `expected.digest`. `go test ./internal/plugin/bundle -run Golden`
checks this; `-update` rewrites the expected files.
