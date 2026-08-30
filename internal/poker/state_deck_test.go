package poker

import (
	"context"
	"testing"

	"github.com/lets-parley/parley/internal/store"
)

// state.deck is the deck the room draws its cards from, so it has to be the
// session's own deck and not a fixed default.
func TestBuildStateUsesSessionDeck(t *testing.T) {
	pool, ac, _ := voteFixture(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		`update sessions set config = '{"deck":"tshirt"}' where id = $1`, ac.Session.ID); err != nil {
		t.Fatal(err)
	}
	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, ac.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	out, err := buildState(ctx, pool, sess)
	if err != nil {
		t.Fatal(err)
	}
	st, ok := out.(State)
	if !ok {
		t.Fatalf("buildState returned %T, want State", out)
	}
	if got := Deck(st.Deck).Name; got != "tshirt" {
		t.Fatalf("state deck = %q, want tshirt", got)
	}
	if !Deck(st.Deck).Has("XL") {
		t.Fatalf("state deck values = %v, want the tshirt cards", Deck(st.Deck).Values)
	}
}
