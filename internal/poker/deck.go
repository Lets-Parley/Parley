package poker

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
		Name:    "fibonacci",
		Values:  append([]string{"1", "2", "3", "5", "8", "13", "21", "34"}, specials...),
		numeric: numbered("1", "2", "3", "5", "8", "13", "21", "34"),
	},
	"modified-fibonacci": {
		Name:   "modified-fibonacci",
		Values: append([]string{"0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100"}, specials...),
		numeric: map[string]float64{
			"0": 0, "½": 0.5, "1": 1, "2": 2, "3": 3, "5": 5, "8": 8, "13": 13, "20": 20, "40": 40, "100": 100,
		},
	},
	"tshirt": {
		Name:    "tshirt",
		Values:  append([]string{"XS", "S", "M", "L", "XL"}, specials...),
		Ordinal: true,
	},
	"powers-of-2": {
		Name:    "powers-of-2",
		Values:  append([]string{"1", "2", "4", "8", "16", "32"}, specials...),
		numeric: numbered("1", "2", "4", "8", "16", "32"),
	},
}

func numbered(vals ...string) map[string]float64 {
	m := make(map[string]float64, len(vals))
	for _, v := range vals {
		var f float64
		for _, c := range v {
			f = f*10 + float64(c-'0')
		}
		m[v] = f
	}
	return m
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

// Config is the poker session config document.
type Config struct {
	Deck string `json:"deck"`
}
