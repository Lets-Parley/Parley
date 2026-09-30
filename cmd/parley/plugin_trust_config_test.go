package main

import (
	"strings"
	"testing"
)

func TestLoadConfigRefusesAMalformedPluginTrustSetting(t *testing.T) {
	for env, value := range map[string]string{
		"PLUGIN_TRUSTED_KEYS":   "not-base64!,",
		"PLUGIN_ALLOW_UNSIGNED": "yes please",
	} {
		t.Run(env, func(t *testing.T) {
			baseConfigEnv(t)
			t.Setenv(env, value)
			if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), env) {
				t.Fatalf("%s=%q: got %v, want an error naming it", env, value, err)
			}
		})
	}
	t.Run("a key of the wrong length", func(t *testing.T) {
		baseConfigEnv(t)
		t.Setenv("PLUGIN_TRUSTED_KEYS", "c2hvcnQ=")
		if _, err := loadConfig(); err == nil {
			t.Fatal("a 5-byte key was accepted")
		}
	})
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
