package poker

import (
	"encoding/json"
	"testing"
)

func TestConfigAutoRevealDefaultsOff(t *testing.T) {
	for _, raw := range []string{`{}`, `{"deck":"fibonacci"}`, `{"deck":"tshirt","autoReveal":false}`} {
		var cfg Config
		if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		if cfg.AutoReveal {
			t.Fatalf("%s: AutoReveal = true, want false for omitted/false", raw)
		}
	}
	var on Config
	if err := json.Unmarshal([]byte(`{"deck":"fibonacci","autoReveal":true}`), &on); err != nil {
		t.Fatal(err)
	}
	if !on.AutoReveal {
		t.Fatal("autoReveal:true did not set AutoReveal")
	}
}

func TestConfigAntics(t *testing.T) {
	var off Config
	if err := json.Unmarshal([]byte(`{"deck":"fibonacci"}`), &off); err != nil {
		t.Fatal(err)
	}
	if off.Antics {
		t.Fatal("omitted antics decoded as true")
	}
	raw, _ := json.Marshal(off)
	if string(raw) != `{"deck":"fibonacci","autoReveal":false}` {
		t.Fatalf("antics off is not omitted: %s", raw)
	}
	var on Config
	if err := json.Unmarshal([]byte(`{"deck":"fibonacci","antics":true}`), &on); err != nil {
		t.Fatal(err)
	}
	raw, _ = json.Marshal(on)
	if !on.Antics || string(raw) != `{"deck":"fibonacci","autoReveal":false,"antics":true}` {
		t.Fatalf("antics true did not round-trip: %s", raw)
	}
}
