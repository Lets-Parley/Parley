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

# ui.js is what the host loads: the embedded fonts, then the readable source.
# It is built, never edited; ui.src.js is the file to read and to copy from.
ui.js: ui.fonts.js ui.src.js
	cat ui.fonts.js ui.src.js > $@

# The limits are there so a test that runs away fails instead of taking the
# machine with it.
test: $(DIST)/$(STEM).ui.js
	node --max-old-space-size=512 --test --test-timeout=10000 board.test.mjs ui.test.mjs package.test.mjs

bundle: ui.js

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
