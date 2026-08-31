package poker

import "testing"

func TestNumericStats(t *testing.T) {
	deck, _ := DeckByName("fibonacci")
	res := Summarize(deck, []string{"3", "5", "5", "8", "?"})
	if res.Average == nil || *res.Average != 5.25 {
		t.Fatalf("average: %v (specials must be excluded)", res.Average)
	}
	if res.Median == nil || *res.Median != 5 {
		t.Fatalf("median: %v", res.Median)
	}
	if res.Mode != nil || res.Range != nil {
		t.Fatal("numeric decks must not report mode/range")
	}
	if len(res.Histogram) != 4 {
		t.Fatalf("histogram rows: %d", len(res.Histogram))
	}
	if res.Consensus {
		t.Fatal("no consensus here")
	}
}

func TestOrdinalDeckHasNoMean(t *testing.T) {
	deck, _ := DeckByName("tshirt")
	res := Summarize(deck, []string{"S", "M", "M", "L"})
	if res.Average != nil || res.Median != nil {
		t.Fatal("ordinal decks must never report average/median")
	}
	if res.Mode == nil || *res.Mode != "M" {
		t.Fatalf("mode: %v", res.Mode)
	}
	if res.Range == nil || *res.Range != "S–L" {
		t.Fatalf("range: %v", res.Range)
	}
}

func TestConsensus(t *testing.T) {
	deck, _ := DeckByName("fibonacci")
	if !Summarize(deck, []string{"5", "5", "5"}).Consensus {
		t.Fatal("unanimous votes must be consensus")
	}
	if Summarize(deck, []string{"5"}).Consensus {
		t.Fatal("a single vote is not consensus")
	}
}

func TestHalfCardNumeric(t *testing.T) {
	deck, _ := DeckByName("modified-fibonacci")
	res := Summarize(deck, []string{"½", "1"})
	if res.Average == nil || *res.Average != 0.75 {
		t.Fatalf("half card average: %v", res.Average)
	}
}

// powers-of-2 is the fourth built-in; without a Summarize assertion here a
// broken numeric map for it would only show up in a live room.
func TestPowersOf2Numeric(t *testing.T) {
	deck, _ := DeckByName("powers-of-2")
	res := Summarize(deck, []string{"2", "4", "4", "8", "?"})
	if res.Average == nil || *res.Average != 4.5 {
		t.Fatalf("average: %v (specials must be excluded)", res.Average)
	}
	if res.Median == nil || *res.Median != 4 {
		t.Fatalf("median: %v", res.Median)
	}
	if res.Mode != nil || res.Range != nil {
		t.Fatal("numeric decks must not report mode/range")
	}
	if len(res.Histogram) != 4 {
		t.Fatalf("histogram rows: %d", len(res.Histogram))
	}
	if res.Consensus {
		t.Fatal("no consensus here")
	}
}

func TestSpecialsAreNeverConsensus(t *testing.T) {
	deck, _ := DeckByName("fibonacci")
	if Summarize(deck, []string{"?", "?", "?"}).Consensus {
		t.Fatal("nobody estimated — that is not consensus")
	}
	if Summarize(deck, []string{"coffee", "coffee"}).Consensus {
		t.Fatal("a unanimous coffee break is not consensus")
	}
	if Summarize(deck, []string{"5", "?"}).Consensus {
		t.Fatal("one estimate plus a shrug is not consensus")
	}
	ordinal, _ := DeckByName("tshirt")
	if Summarize(ordinal, []string{"?", "?"}).Consensus {
		t.Fatal("ordinal decks must not report consensus on specials either")
	}
	if !Summarize(ordinal, []string{"M", "M"}).Consensus {
		t.Fatal("unanimous ordinal votes must still be consensus")
	}
}
