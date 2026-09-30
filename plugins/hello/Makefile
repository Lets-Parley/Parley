# hello: the smallest Parley plugin. `make test` runs the unit tests,
# `make bundle` builds plugin.wasm and packs dist/hello-0.1.0.parley
# (KEY=<file> signs it).

GUEST_SRC := hello.js guest.js

.PHONY: test
test:
	node --test *.test.mjs

include ../../sdk/plugin-sdk/extism.mk
