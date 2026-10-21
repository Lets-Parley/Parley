# settings-demo: a plugin that reads admin-set settings and one secret.
# `make test` runs the unit tests, `make types` regenerates settings.d.ts,
# `make bundle` builds plugin.wasm and packs dist/settings-demo-0.1.0.parley
# (KEY=<file> signs it). The guest is the SDK's host.js, the embedded
# manifest, demo.js and guest.js concatenated.

GUEST_SRC := ../../sdk/plugin-sdk/src/host.js .build/manifest.js demo.js guest.js

.PHONY: test types
test:
	node --test *.test.mjs

types:
	node ../../sdk/plugin-sdk/src/cli.js types . > settings.d.ts

.build/manifest.js: manifest.json
	mkdir -p .build
	{ printf 'var MANIFEST = '; cat manifest.json; printf ';\n'; } > $@

include ../../sdk/plugin-sdk/extism.mk
