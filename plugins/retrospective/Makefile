# Retrospective plugin. `make test` runs the unit tests, `make bundle` builds
# plugin.wasm and packs dist/retrospective-<version>.parley (KEY=<file> signs
# it). The toolchain pins live in sdk/plugin-sdk/extism.mk.
#
# `make dist` still writes the legacy PLUGIN_DIR pair
# (`<name>-<version>.wasm`, `<name>-<version>.ui.js` and
# `<name>-<version>.slots.json`); do not hand-edit the .wasm.

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

$(DIST)/$(STEM).slots.json: slots.json
	mkdir -p $(DIST)
	cp slots.json $@

dist: $(DIST)/$(STEM).wasm $(DIST)/$(STEM).ui.js $(DIST)/$(STEM).slots.json

check-dist: dist
	cmp -s ui.js $(DIST)/$(STEM).ui.js
	cmp -s slots.json $(DIST)/$(STEM).slots.json
	test -s $(DIST)/$(STEM).wasm
