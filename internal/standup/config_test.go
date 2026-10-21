package standup

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/lets-parley/parley/internal/session"
)

func parseStandupConfig(t *testing.T, raw string) (Config, error) {
	t.Helper()
	reg := session.NewRegistry()
	if err := reg.Register(Kind()); err != nil {
		t.Fatal(err)
	}
	out, err := reg.ParseConfig("standup", []byte(raw))
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(out, &cfg); err != nil {
		t.Fatalf("re-decoding %s: %v", out, err)
	}
	return cfg, nil
}

// A config written before async existed carries no mode and must keep meaning
// the round-robin standup it always was.
func TestConfigWithNoModeIsSync(t *testing.T) {
	for _, raw := range []string{`{}`, `{"secondsPerPerson":60}`} {
		cfg, err := parseStandupConfig(t, raw)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if cfg.async() {
			t.Errorf("%s decoded as async", raw)
		}
	}
}

func TestAsyncConfigRoundTrips(t *testing.T) {
	cfg, err := parseStandupConfig(t, `{"mode":"async","closesAt":"2026-09-23T17:00:00Z"}`)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "async" || !cfg.async() {
		t.Errorf("mode = %q, want async", cfg.Mode)
	}
	want := time.Date(2026, 9, 23, 17, 0, 0, 0, time.UTC)
	if cfg.ClosesAt == nil || !cfg.ClosesAt.Equal(want) {
		t.Errorf("closesAt = %v, want %v", cfg.ClosesAt, want)
	}
}

func TestConfigRejectsBadModes(t *testing.T) {
	for _, raw := range []string{
		`{"mode":"Async"}`,
		`{"mode":"later"}`,
		`{"mode":"sync","closesAt":"2026-09-23T17:00:00Z"}`,
		`{"closesAt":"2026-09-23T17:00:00Z"}`,
		`{"mode":"async","closesAt":"tomorrow"}`,
		`{"mode":"async","window":1}`,
	} {
		if _, err := parseStandupConfig(t, raw); err == nil {
			t.Errorf("%s was accepted", raw)
		}
	}
}

// The create dialog sends mode "sync" for every live standup. It is stored as
// no mode at all, so a sync room's document stays readable by a replica that
// predates async — which decodes with DisallowUnknownFields.
func TestSyncModeIsStoredAsNoMode(t *testing.T) {
	reg := session.NewRegistry()
	if err := reg.Register(Kind()); err != nil {
		t.Fatal(err)
	}
	out, err := reg.ParseConfig("standup", []byte(`{"mode":"sync"}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"secondsPerPerson":0}` {
		t.Errorf("stored %s, want the pre-async document", out)
	}
}
