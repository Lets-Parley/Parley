package session

import (
	"encoding/json"
	"testing"
)

// testConfig stands in for a real kind's config document. Registering a kind
// here keeps the test independent of poker and standup, which import this
// package.
type testConfig struct {
	Deck    string `json:"deck"`
	Seconds int    `json:"seconds"`
}

// registerTestKind registers a throwaway kind and restores whatever was there
// before, so the registry is the same after the test as it was going in.
//
// The registry is an unsynchronized package-level map written at init time, so
// nothing in this file may call t.Parallel().
func registerTestKind(t *testing.T, kind string) {
	t.Helper()
	prev, existed := registry[kind]
	Register(kind, nil, func() any { return &testConfig{} })
	t.Cleanup(func() {
		if existed {
			registry[kind] = prev
			return
		}
		delete(registry, kind)
	})
}

func TestKnown(t *testing.T) {
	registerTestKind(t, "kindtest")
	if !Known("kindtest") {
		t.Fatal("Known reports a registered kind as unknown")
	}
	for _, kind := range []string{"", "KINDTEST", "nope"} {
		if Known(kind) {
			t.Errorf("Known(%q) = true, want false", kind)
		}
	}
}

func TestParseConfigRejectsUnknownKind(t *testing.T) {
	if _, err := ParseConfig("no-such-kind", []byte(`{}`)); err == nil {
		t.Fatal("ParseConfig accepted an unregistered kind")
	}
}

func TestParseConfigFillsDefaultsForEmptyInput(t *testing.T) {
	registerTestKind(t, "kindtest")
	// A session created without a config body must still store a valid
	// document, not a null the state builders would have to guard against.
	for _, raw := range [][]byte{nil, {}, []byte(`{}`)} {
		out, err := ParseConfig("kindtest", raw)
		if err != nil {
			t.Fatalf("ParseConfig(%q): %v", raw, err)
		}
		var got testConfig
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatalf("output is not valid JSON: %v", err)
		}
		if got != (testConfig{}) {
			t.Errorf("ParseConfig(%q) = %s, want the zero config", raw, out)
		}
	}
}

func TestParseConfigRejectsBadDocuments(t *testing.T) {
	registerTestKind(t, "kindtest")
	for name, raw := range map[string]string{
		"unknown field":  `{"deck":"fib","sneaky":true}`,
		"wrong type":     `{"seconds":"ninety"}`,
		"not an object":  `["deck"]`,
		"malformed json": `{"deck":`,
		"bare string":    `"fib"`,
	} {
		if out, err := ParseConfig("kindtest", []byte(raw)); err == nil {
			t.Errorf("%s: ParseConfig(%s) returned %s, want an error", name, raw, out)
		}
	}
}

func TestParseConfigNormalizesOutput(t *testing.T) {
	registerTestKind(t, "kindtest")
	// Whatever the client sent, what gets stored is a re-marshalled struct:
	// key order is the struct's and nothing outside it survives.
	out, err := ParseConfig("kindtest", []byte(`{"seconds": 90, "deck":  "fibonacci"}`))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"deck":"fibonacci","seconds":90}`; string(out) != want {
		t.Fatalf("ParseConfig = %s, want %s", out, want)
	}
}

func TestParseConfigRejectsTrailingDocuments(t *testing.T) {
	registerTestKind(t, "kindtest")
	// The decoder reads one value. A second document appended to the body must
	// be an error rather than a silent truncation, so the dropped half can
	// never smuggle a field past the first document's validation.
	for _, raw := range []string{
		`{"deck":"fibonacci"} {"deck":"evil"}`,
		`{"deck":"fibonacci"} garbage`,
		`{"deck":"fibonacci"}{}`,
	} {
		if out, err := ParseConfig("kindtest", []byte(raw)); err == nil {
			t.Errorf("ParseConfig(%s) = %s, want an error", raw, out)
		}
	}
}

func TestRegisterOverwritesAKind(t *testing.T) {
	registerTestKind(t, "kindtest")
	// Two packages registering the same kind is a build-time mistake; the last
	// one wins rather than silently keeping the first, so a duplicate shows up
	// as the wrong config rather than a phantom.
	Register("kindtest", nil, func() any {
		return &struct {
			Other string `json:"other"`
		}{}
	})
	if _, err := ParseConfig("kindtest", []byte(`{"deck":"fibonacci"}`)); err == nil {
		t.Fatal("the re-registered kind still accepts the old config's fields")
	}
	if _, err := ParseConfig("kindtest", []byte(`{"other":"x"}`)); err != nil {
		t.Fatalf("the re-registered kind rejects its own config: %v", err)
	}
}
