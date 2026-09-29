# bundle-v1 golden vectors

**`TEST-ONLY-signing.key` is a published test key (seed bytes 0x00..0x1f). Never
trust it on a real instance.** Its public half is `TEST-ONLY-signing.pub`.

Packing `input/manifest.json`, `input/plugin.wasm`, `input/ui.js` and
`input/slots.json` with that key must produce `expected.parley` exactly, whose
digest is `expected.digest`. `go test ./internal/plugin/bundle -run Golden`
checks this; `-update` rewrites the expected files.

`large/` is a second vector whose wasm is over 128 KiB, so its gzip body spans
several stored blocks. Both vectors were produced by the reference
implementation (`internal/plugin/bundle`), not by an independent packer.
