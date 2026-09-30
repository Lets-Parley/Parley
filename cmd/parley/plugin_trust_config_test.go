package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/plugin/bundle"
)

func TestLoadConfigRefusesAMalformedPluginTrustSetting(t *testing.T) {
	for _, tc := range []struct{ env, value string }{
		{"PLUGIN_TRUSTED_KEYS", "not-base64!,"},
		{"PLUGIN_TRUSTED_KEYS", "c2hvcnQ="}, // five bytes, not a key
		{"PLUGIN_ALLOW_UNSIGNED", "yes please"},
		{"PLUGIN_ALLOW_UNSIGNED", "1"},
		{"PLUGIN_ALLOW_UNSIGNED", "T"},
	} {
		t.Run(tc.env+"="+tc.value, func(t *testing.T) {
			baseConfigEnv(t)
			t.Setenv(tc.env, tc.value)
			if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), tc.env) {
				t.Fatalf("got %v, want an error naming %s", err, tc.env)
			}
		})
	}
}

func TestPluginTrustDefaultsToSignedBundlesOnly(t *testing.T) {
	baseConfigEnv(t)
	t.Setenv("PLUGIN_TRUSTED_KEYS", " 11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo= ,")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PluginAllowUnsigned {
		t.Fatal("unsigned bundles are allowed with PLUGIN_ALLOW_UNSIGNED unset")
	}
	if len(cfg.PluginTrustedKeys) != 1 {
		t.Fatalf("got %d trusted keys, want 1", len(cfg.PluginTrustedKeys))
	}
}

// From the environment, through main's own mapping, to a served bundle: a
// trust setting dropped between loadConfig and the store is dead otherwise.
func TestMainsBundleStoreServesABundleSignedByATrustedKey(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	baseConfigEnv(t)
	t.Setenv("PLUGIN_TRUSTED_KEYS", base64.StdEncoding.EncodeToString(pub))
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	pool := migratedPool(t)
	store := pluginBundles(pool, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))

	name := "trusted-" + base64.RawURLEncoding.EncodeToString(pub[:6])
	data, err := bundle.Pack(map[string][]byte{"plugin.wasm": []byte("\x00asm")},
		[]byte(`{"name":"`+name+`","version":"1.0.0"}`), priv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Insert(t.Context(), data, nil); err != nil {
		t.Fatalf("main's store refused a bundle signed by PLUGIN_TRUSTED_KEYS: %v", err)
	}
	if b, err := store.Stored(t.Context(), name, "1.0.0"); err != nil || b == nil {
		t.Fatalf("main's store did not serve the trusted bundle: %v", err)
	}
}
