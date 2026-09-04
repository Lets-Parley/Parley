package main

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestLoadConfigDefaultsSessionLifetimesToNinetyDays(t *testing.T) {
	baseConfigEnv(t)
	t.Setenv("SESSION_IDLE_TTL", "")
	t.Setenv("SESSION_MAX_TTL", "")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	// 2160h is 90 days, written out rather than computed from the parser.
	if cfg.SessionIdleTTL != 2160*time.Hour {
		t.Errorf("SessionIdleTTL = %s, want 2160h0m0s", cfg.SessionIdleTTL)
	}
	if cfg.SessionMaxTTL != 2160*time.Hour {
		t.Errorf("SessionMaxTTL = %s, want 2160h0m0s", cfg.SessionMaxTTL)
	}
}

func TestLoadConfigReadsSessionLifetimes(t *testing.T) {
	baseConfigEnv(t)
	t.Setenv("SESSION_IDLE_TTL", "8h")
	t.Setenv("SESSION_MAX_TTL", "72h")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SessionIdleTTL != 8*time.Hour {
		t.Errorf("SessionIdleTTL = %s, want 8h0m0s", cfg.SessionIdleTTL)
	}
	if cfg.SessionMaxTTL != 72*time.Hour {
		t.Errorf("SessionMaxTTL = %s, want 72h0m0s", cfg.SessionMaxTTL)
	}
}

// A lifetime that does not parse, or is zero or negative, must stop the boot.
// Falling back to the default would leave an operator who typed "8" believing
// sessions end after eight hours when they last ninety days.
func TestLoadConfigRejectsBadSessionLifetimes(t *testing.T) {
	for _, name := range []string{"SESSION_IDLE_TTL", "SESSION_MAX_TTL"} {
		for _, value := range []string{"0", "0h", "-1h", "8", "soon"} {
			t.Run(name+"="+value, func(t *testing.T) {
				baseConfigEnv(t)
				t.Setenv(name, value)
				if _, err := loadConfig(); err == nil {
					t.Errorf("%s=%q was accepted", name, value)
				}
			})
		}
	}
}

func TestBootFieldsNameTheSessionLifetimes(t *testing.T) {
	cfg := bootConfig(t)
	cfg.SessionIdleTTL = 8 * time.Hour
	cfg.SessionMaxTTL = 72 * time.Hour

	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("boot settings", bootFields(cfg, true)...)

	out := buf.String()
	for _, want := range []string{`"session_idle_ttl":"8h0m0s"`, `"session_max_ttl":"72h0m0s"`} {
		if !strings.Contains(out, want) {
			t.Errorf("boot line %s is missing %s", out, want)
		}
	}
}

// The HTTP layer is where the cookie's Max-Age and the store's lifetimes come
// from, so a config field that never reaches api.Options is dead in the
// shipped binary however carefully it was parsed.
func TestAPIOptionsCarryTheSessionLifetimes(t *testing.T) {
	cfg := bootConfig(t)
	cfg.SessionIdleTTL = 8 * time.Hour
	cfg.SessionMaxTTL = 72 * time.Hour
	opts := apiOptions(t.Context(), cfg, true, nil, nil)
	if opts.SessionIdleTTL != 8*time.Hour || opts.SessionMaxTTL != 72*time.Hour {
		t.Errorf("api.Options got idle=%s max=%s, want 8h0m0s and 72h0m0s", opts.SessionIdleTTL, opts.SessionMaxTTL)
	}
}
