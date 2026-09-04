# Retrospective plugin — build the Extism guest and name the PLUGIN_DIR files.
#
# The host loads `<name>-<version>.wasm` (DirBundles) and
# `<name>-<version>.ui.js` (readPluginUI). This recipe is the source of those
# two files; do not hand-edit the .wasm.

NAME    := retrospective
VERSION := 0.1.0
STEM    := $(NAME)-$(VERSION)

EXTISM_JS_VERSION := v1.7.0
BINARYEN_VERSION  := version_132
CACHE             := .cache
BUILD             := .build
DIST              := dist

UNAME_S := $(shell uname -s | tr '[:upper:]' '[:lower:]')
UNAME_M := $(shell uname -m)
ifeq ($(UNAME_S),darwin)
  OS := macos
  BINARYEN_OS := macos
else
  OS := linux
  BINARYEN_OS := linux
endif
ifeq ($(UNAME_M),arm64)
  ARCH := aarch64
  BINARYEN_ARCH := arm64
else ifeq ($(UNAME_M),aarch64)
  ARCH := aarch64
  BINARYEN_ARCH := aarch64
else
  ARCH := x86_64
  BINARYEN_ARCH := x86_64
endif

EXTISM_JS := $(CACHE)/extism-js
EXTISM_GZ := extism-js-$(ARCH)-$(OS)-$(EXTISM_JS_VERSION).gz
EXTISM_URL := https://github.com/extism/js-pdk/releases/download/$(EXTISM_JS_VERSION)/$(EXTISM_GZ)
BINARYEN_TGZ := binaryen-$(BINARYEN_VERSION)-$(BINARYEN_ARCH)-$(BINARYEN_OS).tar.gz
BINARYEN_URL := https://github.com/WebAssembly/binaryen/releases/download/$(BINARYEN_VERSION)/$(BINARYEN_TGZ)
BINARYEN_BIN := $(CACHE)/binaryen/bin

# SHA-256 of the downloaded archives (GitHub release assets), checked before extract.
EXTISM_SHA256.x86_64.linux   := 63b72da2f5e88655522dc21477de549f238a2f40546a69ce4e0fce7e78654035
EXTISM_SHA256.x86_64.macos   := cce4a756eceb34b5aaac5ea864607d6c8b0610535e2c1b0c05a96bdbda69c7bb
EXTISM_SHA256.aarch64.linux  := 025f4050b199d68413c159bde1187271ae270021a9f7171e7beb509922821f2a
EXTISM_SHA256.aarch64.macos  := 12c01c2bb2240a6a05a4f8babe680c793c397d84e6a1497a7ca1312e78a475c3
EXTISM_SHA256 := $(EXTISM_SHA256.$(ARCH).$(OS))

BINARYEN_SHA256.x86_64.linux  := 195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572
BINARYEN_SHA256.x86_64.macos  := 40c3de90bb3766bd0282a895e139a6f50253dba49b4f5bb89e66faca162d832e
BINARYEN_SHA256.aarch64.linux := c58562417836c5d0493d89bdefc434933bdc097db641b483df86bcfa557a107f
BINARYEN_SHA256.arm64.macos   := 98aad827847af7ef990ed7098d885725c8e5b5aae75073403635617ae4e259aa
BINARYEN_SHA256 := $(BINARYEN_SHA256.$(BINARYEN_ARCH).$(BINARYEN_OS))

.PHONY: all test dist check-dist clean

all: test dist check-dist

test:
	node --test board.test.mjs ui.test.mjs package.test.mjs

$(EXTISM_JS):
	mkdir -p $(CACHE)
	curl -fsSL -o $(CACHE)/$(EXTISM_GZ) "$(EXTISM_URL)"
	@if [ -z "$(EXTISM_SHA256)" ]; then echo "no pinned SHA-256 for extism-js $(ARCH)-$(OS)" >&2; exit 1; fi
	echo "$(EXTISM_SHA256)  $(CACHE)/$(EXTISM_GZ)" | sha256sum -c -
	gunzip -c $(CACHE)/$(EXTISM_GZ) > $@
	chmod +x $@

$(BINARYEN_BIN)/wasm-merge:
	mkdir -p $(CACHE)
	curl -fsSL -o $(CACHE)/$(BINARYEN_TGZ) "$(BINARYEN_URL)"
	@if [ -z "$(BINARYEN_SHA256)" ]; then echo "no pinned SHA-256 for binaryen $(BINARYEN_ARCH)-$(BINARYEN_OS)" >&2; exit 1; fi
	echo "$(BINARYEN_SHA256)  $(CACHE)/$(BINARYEN_TGZ)" | sha256sum -c -
	rm -rf $(CACHE)/binaryen $(CACHE)/binaryen-$(BINARYEN_VERSION)
	tar -xzf $(CACHE)/$(BINARYEN_TGZ) -C $(CACHE)
	mv $(CACHE)/binaryen-$(BINARYEN_VERSION) $(CACHE)/binaryen

$(BUILD)/guest.js: board.js guest.js
	mkdir -p $(BUILD)
	cat board.js guest.js > $@

$(DIST)/$(STEM).wasm: $(BUILD)/guest.js guest.d.ts $(EXTISM_JS) $(BINARYEN_BIN)/wasm-merge
	mkdir -p $(DIST)
	PATH="$(CURDIR)/$(BINARYEN_BIN):$$PATH" $(EXTISM_JS) $(BUILD)/guest.js -i guest.d.ts -o $@

$(DIST)/$(STEM).ui.js: ui.js
	mkdir -p $(DIST)
	cp ui.js $@

dist: $(DIST)/$(STEM).wasm $(DIST)/$(STEM).ui.js

check-dist: dist
	cmp -s ui.js $(DIST)/$(STEM).ui.js
	test -s $(DIST)/$(STEM).wasm

clean:
	rm -rf $(BUILD) $(DIST) $(CACHE)
