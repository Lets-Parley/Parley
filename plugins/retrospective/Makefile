# Retrospective plugin. `make test` runs the unit tests, `make bundle` builds
# plugin.wasm and packs dist/retrospective-<version>.parley (KEY=<file> signs
# it). The toolchain pins live in sdk/plugin-sdk/extism.mk.
#
# `make dist` still writes the legacy PLUGIN_DIR pair
# (`<name>-<version>.wasm` and `<name>-<version>.ui.js`); do not hand-edit the
# .wasm.

GUEST_SRC := board.js guest.js
STEM      := retrospective-$(shell node -p 'require("./manifest.json").version')
DIST      := dist

.PHONY: all test dist check-dist

all: test dist check-dist

test:
	node --test board.test.mjs ui.test.mjs package.test.mjs

include ../../sdk/plugin-sdk/extism.mk

$(DIST)/$(STEM).wasm: plugin.wasm
	mkdir -p $(DIST)
	cp plugin.wasm $@

$(DIST)/$(STEM).ui.js: ui.js
	mkdir -p $(DIST)
	cp ui.js $@

dist: $(DIST)/$(STEM).wasm $(DIST)/$(STEM).ui.js

check-dist: dist
	cmp -s ui.js $(DIST)/$(STEM).ui.js
	test -s $(DIST)/$(STEM).wasm
