package poker

import (
	"math"
	"sort"
)

type HistogramRow struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// Results is what the room reads after a reveal. Numeric decks carry
// avg/median; ordinal decks carry mode/range only — printing "average: 4.5"
// over S/M/L would be a correctness bug on a shared screen.
type Results struct {
	Histogram []HistogramRow `json:"histogram"`
	Average   *float64       `json:"average,omitempty"`
	Median    *float64       `json:"median,omitempty"`
	Mode      *string        `json:"mode,omitempty"`
	Range     *string        `json:"range,omitempty"`
	Consensus bool           `json:"consensus"`
}

func Summarize(deck Deck, values []string) Results {
	counts := map[string]int{}
	for _, v := range values {
		counts[v]++
	}
	res := Results{Histogram: []HistogramRow{}}
	for _, v := range deck.Values {
		if counts[v] > 0 {
			res.Histogram = append(res.Histogram, HistogramRow{Value: v, Count: counts[v]})
		}
	}
	// A room where everyone shrugged ("?") or called for a break collapses to a
	// single histogram row too — that is not agreement on an estimate.
	res.Consensus = len(res.Histogram) == 1 && len(values) > 1 && !isSpecial(res.Histogram[0].Value)

	if deck.Ordinal {
		res.Mode, res.Range = ordinalStats(deck, counts)
		return res
	}

	nums := []float64{}
	for _, v := range values {
		if n, ok := deck.numeric[v]; ok {
			nums = append(nums, n)
		}
	}
	if len(nums) == 0 {
		return res
	}
	sort.Float64s(nums)
	sum := 0.0
	for _, n := range nums {
		sum += n
	}
	avg := sum / float64(len(nums))
	var med float64
	if len(nums)%2 == 1 {
		med = nums[len(nums)/2]
	} else {
		med = (nums[len(nums)/2-1] + nums[len(nums)/2]) / 2
	}
	// Individually finite cards can still sum past float64: an overflowed
	// average is +Inf, which encoding/json refuses, and Results is marshalled
	// into the state payload every client in the room reads. Omitting the
	// number beats poisoning the whole broadcast.
	if finite(avg) && finite(med) {
		res.Average, res.Median = &avg, &med
	}
	return res
}

func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }

func ordinalStats(deck Deck, counts map[string]int) (mode, rng *string) {
	best, bestCount := "", 0
	lo, hi := -1, -1
	for i, v := range deck.Values {
		c := counts[v]
		if c == 0 {
			continue
		}
		if isSpecial(v) {
			continue
		}
		if c > bestCount {
			best, bestCount = v, c
		}
		if lo == -1 {
			lo = i
		}
		hi = i
	}
	if bestCount == 0 {
		return nil, nil
	}
	r := deck.Values[lo]
	if hi != lo {
		r = deck.Values[lo] + "–" + deck.Values[hi]
	}
	return &best, &r
}

func isSpecial(v string) bool {
	for _, s := range specials {
		if v == s {
			return true
		}
	}
	return false
}
