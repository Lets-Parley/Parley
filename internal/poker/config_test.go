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
