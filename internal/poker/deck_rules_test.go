package poker

import (
	"encoding/json"
	"strings"
	"testing"
)

// A card that ParseFloat accepts but JSON cannot carry — NaN, ±Inf — would
// reach Summarize and make json.Marshal of the whole broadcast state fail,
// breaking the reveal for every client in the room.
func TestConfigRejectsNonFiniteCards(t *testing.T) {
	for _, v := range []string{"NaN", "Inf", "+Inf", "-Inf", "Infinity"} {
		raw := `{"deck":{"name":"x","values":["1","` + v + `"]}}`
		var cfg Config
		if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
			continue // rejected at decode is just as good
		}
		if err := cfg.Validate(); err == nil {
			t.Fatalf("card %q was accepted as a number", v)
		}
	}
}

// The reveal path must stay marshallable even if such a card ever got stored.
func TestSummarizeStaysMarshallable(t *testing.T) {
	d := Deck{Name: "x", Values: []string{"1", "NaN"}}
	d.numeric = derive(d.Values, false)
	if _, err := json.Marshal(Summarize(d, []string{"NaN", "NaN"})); err != nil {
		t.Fatalf("results of a NaN card do not marshal: %v", err)
	}
}

// A custom deck that borrows a built-in name has its cards silently discarded
// by MarshalJSON. Refuse it instead.
func TestConfigRejectsCustomDeckWithBuiltinName(t *testing.T) {
	var cfg Config
	if err := json.Unmarshal([]byte(`{"deck":{"name":"fibonacci","values":["1","2","999"]}}`), &cfg); err != nil {
		return
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("a custom deck named fibonacci was accepted")
	}
	// A built-in named by itself still validates.
	var builtin Config
	if err := json.Unmarshal([]byte(`{"deck":"fibonacci"}`), &builtin); err != nil {
		t.Fatal(err)
	}
	if err := builtin.Validate(); err != nil {
		t.Fatalf("the built-in fibonacci deck was rejected: %v", err)
	}
}

// A submitted special must be rejected, not silently stripped. The card count
// here clears the 2-15 bound, so only the reserved-card rule can fail it.
func TestConfigRejectsSubmittedSpecials(t *testing.T) {
	for _, v := range specials {
		raw := `{"deck":{"name":"x","values":["1","2","` + v + `"]}}`
		var cfg Config
		if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
			continue
		}
		err := cfg.Validate()
		if err == nil {
			t.Fatalf("card %q was accepted", v)
		}
		if !strings.Contains(err.Error(), "reserved") {
			t.Fatalf("card %q was rejected by the wrong rule: %v", v, err)
		}
	}
}
