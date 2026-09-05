package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
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

// An operator of the -fips image has no other way to confirm the process is
// actually in FIPS 140-3 mode, so the boot line has to name it. The value is
// the GODEBUG setting (off / on / only), never a boolean — "on" and "only"
// are both "enabled" and the difference is load-bearing.
func TestBootFieldsReportFIPS140Mode(t *testing.T) {
	cfg := bootConfig(t)

	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("boot settings", bootFields(cfg, true)...)

	var payload map[string]any
	if err := json.Unmarshal(buf.Bytes(), &payload); err != nil {
		t.Fatalf("boot line is not JSON: %v\n%s", err, buf.String())
	}
	got, ok := payload["fips140"].(string)
	if !ok {
		t.Fatalf("boot line %s is missing fips140 as a string", buf.String())
	}
	switch got {
	case "off", "on", "only":
	default:
		t.Fatalf("fips140 = %q, want off, on, or only", got)
	}

	// Hand-parsed from GODEBUG, not from the helper under test. Last fips140=
	// wins, matching how the runtime reads the variable.
	wantFromEnv := ""
	for _, part := range strings.Split(os.Getenv("GODEBUG"), ",") {
		key, val, found := strings.Cut(strings.TrimSpace(part), "=")
		if found && key == "fips140" {
			wantFromEnv = val
		}
	}
	if wantFromEnv != "" && got != wantFromEnv {
		t.Errorf("fips140 = %q, want %q from GODEBUG", got, wantFromEnv)
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
