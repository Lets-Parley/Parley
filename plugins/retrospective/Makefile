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

.PHONY: all test dist clean

all: test dist

test:
	node --test board.test.mjs ui.test.mjs package.test.mjs

$(EXTISM_JS):
	mkdir -p $(CACHE)
	curl -fsSL -o $(CACHE)/$(EXTISM_GZ) "$(EXTISM_URL)"
	gunzip -c $(CACHE)/$(EXTISM_GZ) > $@
	chmod +x $@

$(BINARYEN_BIN)/wasm-merge:
	mkdir -p $(CACHE)
	curl -fsSL -o $(CACHE)/$(BINARYEN_TGZ) "$(BINARYEN_URL)"
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

clean:
	rm -rf $(BUILD) $(DIST) $(CACHE)
