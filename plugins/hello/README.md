# hello

The smallest Parley plugin: one session kind (`hello`), a UI that prints the
greeting from the room state, and no capabilities, so the consent screen has
nothing to ask.

```sh
make test                  # node --test, no toolchain needed
make bundle                # builds plugin.wasm, packs dist/hello-0.1.0.parley
make bundle KEY=my.key     # the same, signed
```

`make bundle` downloads pinned, checksummed `extism-js` and `binaryen` into
`.cache/` on first use (`sdk/plugin-sdk/extism.mk`). Upload the bundle to your
instance's catalog and install it from there; the
[Build your first plugin](https://www.letsparley.io/reference/build-your-first-plugin/)
runbook walks through every step.
