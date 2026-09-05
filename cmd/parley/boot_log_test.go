package main

import (
	"bytes"
	"log/slog"
	"net/netip"
	"net/url"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/api"
)

func bootConfig(t *testing.T) config {
	t.Helper()
	base, err := url.Parse("https://parley.example.test")
	if err != nil {
		t.Fatal(err)
	}
	return config{Port: "8080", BaseURL: base, AuthMode: api.ModeOpen}
}

// An operator turning on TRUST_PROXY_HEADERS has no other way to confirm which
// CIDRs were accepted, so the boot line has to name them.
func TestBootFieldsNameTheParsedTrustedProxyCIDRs(t *testing.T) {
	cfg := bootConfig(t)
	cfg.TrustProxy = true
	cfg.TrustedProxyCIDRs = []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("2001:db8::/32"),
	}

	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("boot settings", bootFields(cfg, true)...)

	out := buf.String()
	for _, want := range []string{"trusted_proxy_cidrs", "10.0.0.0/8", "2001:db8::/32"} {
		if !strings.Contains(out, want) {
			t.Errorf("boot line %s is missing %q", out, want)
		}
	}
}

func TestBootFieldsOmitTrustedProxyCIDRsWhenProxyTrustIsOff(t *testing.T) {
	cfg := bootConfig(t)

	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("boot settings", bootFields(cfg, true)...)

	if strings.Contains(buf.String(), "trusted_proxy_cidrs") {
		t.Errorf("boot line %s names trusted_proxy_cidrs with proxy trust off", buf.String())
	}
}

func TestBootFieldsNameMetricsEnabled(t *testing.T) {
	cfg := bootConfig(t)
	cfg.MetricsEnabled = true

	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("boot settings", bootFields(cfg, true)...)

	if !strings.Contains(buf.String(), `"metrics_enabled":true`) {
		t.Errorf("boot line %s is missing metrics_enabled=true", buf.String())
	}
}
