package poker

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// specials are always appended: "?" = no idea, "coffee" = need a break.
// They never enter numeric stats.
var specials = []string{"?", "coffee"}

type Deck struct {
	Name    string   `json:"name"`
	Values  []string `json:"values"`
	Ordinal bool     `json:"ordinal"`
	numeric map[string]float64
}

var decks = map[string]Deck{
	"fibonacci": {
		Name:   "fibonacci",
		Values: append([]string{"1", "2", "3", "5", "8", "13", "21", "34"}, specials...),
	},
	"modified-fibonacci": {
		Name:   "modified-fibonacci",
		Values: append([]string{"0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100"}, specials...),
	},
	"tshirt": {
		Name:    "tshirt",
		Values:  append([]string{"XS", "S", "M", "L", "XL"}, specials...),
		Ordinal: true,
	},
	"powers-of-2": {
		Name:   "powers-of-2",
		Values: append([]string{"1", "2", "4", "8", "16", "32"}, specials...),
	},
}

// derive reads a deck's numeric values off its cards. "½" is the one card in
// the built-in decks that no number parser accepts, so it gets an alias; every
// other card is whatever strconv.ParseFloat makes of it. An ordinal deck has
// no numerics at all.
func derive(values []string, ordinal bool) map[string]float64 {
	if ordinal {
		return nil
	}
	m := map[string]float64{}
	for _, v := range values {
		if n, ok := cardValue(v); ok {
			m[v] = n
		}
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

func cardValue(v string) (float64, bool) {
	if v == "\u00bd" {
		return 0.5, true
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func init() {
	for name, d := range decks {
		d.numeric = derive(d.Values, d.Ordinal)
		decks[name] = d
	}
}

func DeckByName(name string) (Deck, bool) {
	d, ok := decks[name]
	return d, ok
}

func (d Deck) Has(value string) bool {
	for _, v := range d.Values {
		if v == value {
			return true
		}
	}
	return false
}

// wireDeck is the deck as it appears in state.deck. It is a distinct type so
// it does not inherit Deck's config marshalling, which writes a bare name.
type wireDeck Deck

// UnmarshalJSON accepts both shapes a stored config can hold: the legacy bare
// name of a built-in deck, and the object form a custom deck is written in.
func (d *Deck) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var name string
		if err := json.Unmarshal(b, &name); err != nil {
			return err
		}
		if name == "" {
			*d = Deck{}
			return nil
		}
		built, ok := decks[name]
		if !ok {
			return fmt.Errorf("unknown deck %q", name)
		}
		*d = built
		return nil
	}
	var raw struct {
		Name    string   `json:"name"`
		Values  []string `json:"values"`
		Ordinal bool     `json:"ordinal"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	// The specials are the server's, always appended and never stored, so a
	// custom deck carries only its own cards on disk.
	values := append(append([]string{}, raw.Values...), specials...)
	*d = Deck{Name: raw.Name, Values: values, Ordinal: raw.Ordinal, numeric: derive(values, raw.Ordinal)}
	return nil
}

// MarshalJSON writes the legacy bare name for a built-in deck, so a config
// written here is byte-identical to one written before decks became values and
// an older binary rolls back cleanly. Only a custom deck takes the object form.
func (d Deck) MarshalJSON() ([]byte, error) {
	if _, ok := decks[d.Name]; ok || len(d.Values) == 0 {
		return json.Marshal(d.Name)
	}
	return json.Marshal(struct {
		Name    string   `json:"name"`
		Values  []string `json:"values"`
		Ordinal bool     `json:"ordinal"`
	}{d.Name, cards(d.Values), d.Ordinal})
}

// cards is a deck's values without the specials the server appends.
func cards(values []string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		if !isSpecial(v) {
			out = append(out, v)
		}
	}
	return out
}

// Config is the poker session config document.
type Config struct {
	Deck       Deck `json:"deck"`
	AutoReveal bool `json:"autoReveal"`
}

// ResolveDeck is the session's deck. A config that names no deck — every
// session created before the deck field existed — plays fibonacci.
func (c Config) ResolveDeck() Deck {
	if len(c.Deck.Values) == 0 {
		return decks["fibonacci"]
	}
	return c.Deck
}

// Validate enforces the card rules on a custom deck. Session config reaches
// here straight from a space member, so this is the trust boundary: without it
// any member could store arbitrary card values, counts and lengths.
func (c Config) Validate() error {
	d := c.Deck
	if _, builtin := decks[d.Name]; builtin || len(d.Values) == 0 {
		return nil
	}
	if strings.TrimSpace(d.Name) == "" || len(d.Name) > 40 {
		return fmt.Errorf("a deck needs a name of 1-40 characters")
	}
	cs := cards(d.Values)
	if len(cs) < 2 || len(cs) > 15 {
		return fmt.Errorf("a deck needs 2-15 cards, got %d", len(cs))
	}
	seen := map[string]bool{}
	for _, v := range cs {
		if n := len([]rune(v)); n < 1 || n > 8 {
			return fmt.Errorf("card %q is not 1-8 characters", v)
		}
		if isSpecial(v) {
			return fmt.Errorf("card %q is reserved", v)
		}
		if seen[v] {
			return fmt.Errorf("card %q is listed twice", v)
		}
		seen[v] = true
		if _, ok := cardValue(v); !ok && !d.Ordinal {
			return fmt.Errorf("card %q is not a number, so this deck has to be ordinal", v)
		}
	}
	return nil
}
