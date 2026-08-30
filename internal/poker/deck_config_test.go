package poker

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/session"
)

// A config written by this binary must be byte-identical to one written before
// the deck became a value, or an older binary cannot read it after a rollback.
func TestConfigLegacyBytesRoundTrip(t *testing.T) {
	for _, raw := range []string{
		`{"deck":"fibonacci","autoReveal":false}`,
		`{"deck":"tshirt","autoReveal":true}`,
		`{"deck":"modified-fibonacci","autoReveal":false}`,
		`{"deck":"powers-of-2","autoReveal":false}`,
		`{"deck":"","autoReveal":false}`,
	} {
		var cfg Config
		if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		out, err := json.Marshal(cfg)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if string(out) != raw {
			t.Fatalf("round trip of %s produced %s", raw, out)
		}
	}
}

func TestConfigDeckResolves(t *testing.T) {
	var empty Config
	if got := empty.ResolveDeck().Name; got != "fibonacci" {
		t.Fatalf("empty config resolved to %q, want fibonacci", got)
	}
	var cfg Config
	if err := json.Unmarshal([]byte(`{"deck":"tshirt"}`), &cfg); err != nil {
		t.Fatal(err)
	}
	if got := cfg.ResolveDeck().Name; got != "tshirt" {
		t.Fatalf("resolved to %q, want tshirt", got)
	}
}

func TestConfigUnknownDeckNameIsAnError(t *testing.T) {
	var cfg Config
	if err := json.Unmarshal([]byte(`{"deck":"tarot"}`), &cfg); err == nil {
		t.Fatal("an unknown deck name decoded without error")
	}
}

func TestConfigCustomDeckRoundTripsAndDerivesNumerics(t *testing.T) {
	raw := `{"deck":{"name":"team","values":["1","3","½"],"ordinal":false},"autoReveal":false}`
	var cfg Config
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid custom deck rejected: %v", err)
	}
	d := cfg.ResolveDeck()
	if !d.Has("?") || !d.Has("coffee") {
		t.Fatal("specials were not appended to a custom deck")
	}
	if d.numeric["½"] != 0.5 || d.numeric["3"] != 3 {
		t.Fatalf("numerics not derived: %v", d.numeric)
	}
	out, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != raw {
		t.Fatalf("custom deck round trip produced %s", out)
	}
}

func TestConfigValidateRejectsBadCards(t *testing.T) {
	cases := map[string]string{
		"too few":     `{"deck":{"name":"x","values":["1"]}}`,
		"too many":    `{"deck":{"name":"x","values":["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16"]}}`,
		"too long":    `{"deck":{"name":"x","values":["1","123456789"]}}`,
		"empty card":  `{"deck":{"name":"x","values":["1",""]}}`,
		"duplicate":   `{"deck":{"name":"x","values":["1","1"]}}`,
		"special":     `{"deck":{"name":"x","values":["1","?"]}}`,
		"non numeric": `{"deck":{"name":"x","values":["1","big"]}}`,
		"unnamed":     `{"deck":{"name":"","values":["1","2"]}}`,
	}
	for name, raw := range cases {
		var cfg Config
		if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
			continue // rejected at decode is just as good
		}
		if err := cfg.Validate(); err == nil {
			t.Fatalf("%s: %s was accepted", name, raw)
		}
	}
	var ordinal Config
	if err := json.Unmarshal([]byte(`{"deck":{"name":"x","values":["small","big"],"ordinal":true}}`), &ordinal); err != nil {
		t.Fatal(err)
	}
	if err := ordinal.Validate(); err != nil {
		t.Fatalf("an ordinal deck of words was rejected: %v", err)
	}
}

// state.deck stays the object shape it has always been, with no numeric map.
func TestStateDeckWireShapeUnchanged(t *testing.T) {
	deck, _ := DeckByName("fibonacci")
	out, err := json.Marshal(State{Deck: wireDeck(deck), Stories: []WireStory{}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"deck":{"name":"fibonacci","values":["1","2","3","5","8","13","21","34","?","coffee"],"ordinal":false}`) {
		t.Fatalf("state deck shape changed: %s", out)
	}
	if strings.Contains(string(out), "numeric") {
		t.Fatalf("numeric map leaked onto the wire: %s", out)
	}
}

// The registry is the gate a created session's config passes through.
func TestParseConfigThroughTheRegistry(t *testing.T) {
	r := session.NewRegistry()
	if err := r.Register(Kind()); err != nil {
		t.Fatal(err)
	}
	out, err := r.ParseConfig("poker", []byte(`{"deck":"fibonacci"}`))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"deck":"fibonacci","autoReveal":false}`; string(out) != want {
		t.Fatalf("stored config = %s, want %s", out, want)
	}
	for _, raw := range []string{
		`{"deck":"tarot"}`,
		`{"deck":{"name":"x","values":["1","1"]}}`,
		`{"deck":{"name":"x","values":["1","toolongacard"]}}`,
		`{"deck":{"name":"x","values":["1","word"]}}`,
	} {
		if _, err := r.ParseConfig("poker", []byte(raw)); err == nil {
			t.Fatalf("%s was accepted", raw)
		}
	}
}
