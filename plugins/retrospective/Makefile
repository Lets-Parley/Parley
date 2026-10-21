# Retrospective plugin. `make test` runs the unit tests, `make bundle` builds
# plugin.wasm and packs dist/retrospective-<version>.parley (KEY=<file> signs
# it). The toolchain pins live in sdk/plugin-sdk/extism.mk.
#
# `make dist` still writes the legacy PLUGIN_DIR pair
# (`<name>-<version>.wasm`, `<name>-<version>.ui.js` and
# `<name>-<version>.slots.json`). The .wasm is build output and is not
# tracked; CI diffs the committed .ui.js and .slots.json against a rebuild.

GUEST_SRC := board.js guest.js
STEM      := retrospective-$(shell node -p 'require("./manifest.json").version')
DIST      := dist

.PHONY: all test dist check-dist check-ui-src

all: test dist check-dist

# The board's source is the ES modules under ui/, one concern to a file. They
# are valid ES modules (ui.test.mjs loads them natively from main.js), and
# the build joins them, in this order, into one function scope, dropping each
# file's leading imports and every `export `.
# The order is the order the board's top-level code runs in, so a file comes
# after everything its top-level statements use. Every file under ui/ must be
# listed here, and every file listed must exist.
UI_SRC := \
  ui/bridge/host.js \
  ui/utils/bag.js \
  ui/assets/glyphs.js \
  ui/assets/stickers.js \
  ui/constants/board.js \
  ui/styles/tokens.js \
  ui/styles/base.js \
  ui/styles/header.js \
  ui/styles/lanes.js \
  ui/styles/notes.js \
  ui/styles/stickers.js \
  ui/styles/actions.js \
  ui/styles/popovers.js \
  ui/styles/responsive.js \
  ui/styles/sheet.js \
  ui/utils/dom.js \
  ui/utils/text.js \
  ui/bridge/state.js \
  ui/components/people.js \
  ui/utils/motion.js \
  ui/components/notices.js \
  ui/components/popover.js \
  ui/components/menu.js \
  ui/bridge/actions.js \
  ui/components/stage-bar.js \
  ui/components/timer.js \
  ui/components/authorship.js \
  ui/components/lane.js \
  ui/features/compose.js \
  ui/components/note.js \
  ui/features/voting.js \
  ui/components/note-menu.js \
  ui/features/editing.js \
  ui/components/group.js \
  ui/features/moves.js \
  ui/features/drag.js \
  ui/features/drag-scroll.js \
  ui/features/sticker-layout.js \
  ui/features/sticker-actions.js \
  ui/components/sticker.js \
  ui/components/sticker-book.js \
  ui/components/sticker-list.js \
  ui/features/render.js \
  ui/components/selection-bar.js \
  ui/components/action-list.js \
  ui/components/links.js \
  ui/main.js

# Runs on every build, not only when a listed file changed: an unlisted file is
# exactly the one make would not notice.
check-ui-src:
	@bad=0; \
	for f in $$(find ui -name '*.js' | sort); do \
	  case " $(UI_SRC) " in *" $$f "*) ;; *) echo "$$f is not listed in UI_SRC" >&2; bad=1 ;; esac; \
	done; \
	for f in $(UI_SRC); do [ -f "$$f" ] || { echo "$$f is listed in UI_SRC but missing" >&2; bad=1; }; done; \
	exit $$bad

# ui.board.js is the board on its own, the file the tests run; ui.js is what
# the host loads, the embedded fonts followed by the board. Both are built,
# never edited.
ui.board.js: $(UI_SRC) ui-join.awk Makefile | check-ui-src
	{ printf '(function () {\n  "use strict";\n\n' && \
	  awk -f ui-join.awk $(UI_SRC) && \
	  printf '})();\n'; } > $@.tmp
	mv $@.tmp $@

ui.js: ui.fonts.js ui.board.js
	cat ui.fonts.js ui.board.js > $@

# The limits are there so a test that runs away fails instead of taking the
# machine with it.
test: $(DIST)/$(STEM).ui.js
	@# The address-space limit is inherited by the per-file test processes,
	@# which the heap flag is not; a runaway dies at 3 GB instead of taking
	@# the machine. Where the shell cannot set it, the tests still run.
	ulimit -v 3145728 2>/dev/null; node --max-old-space-size=512 --experimental-vm-modules --test --test-timeout=10000 board.test.mjs guest.test.mjs ui.test.mjs package.test.mjs

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
