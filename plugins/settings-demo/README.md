# settings-demo

A plugin configured by an org admin. `manifest.json` declares a `settings`
schema with a string (`greeting`), a boolean (`loud`), an enum (`mood`) and one
secret (`api_token`). The guest reads the plain values with `getSettings()` and
the secret with `getSecret("api_token")` from `@parley/plugin-sdk`, and tells
the room only whether a token is configured, never the token.

```sh
make test                  # node --test, no toolchain needed
make types                 # regenerate settings.d.ts from the schema
make bundle KEY=my.key     # builds plugin.wasm, packs dist/settings-demo-0.1.0.parley
```

The guest is the SDK's `host.js`, the manifest (embedded by the Makefile),
`demo.js` and `guest.js` concatenated: the Extism JavaScript guest has no module
loader. It imports the `parley_settings_get` host function, so it loads only
on an instance whose host provides plugin settings.
