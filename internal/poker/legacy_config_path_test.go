package poker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/store"
)

// A session whose config is still the pre-#424 bare-name shape must vote,
// reveal, and save an estimate the same way a fresh session does. Vote was
// already covered via voteFixture; reveal and estimate previously only ran
// against `{}`.
func TestLegacyStoredConfigRevealAndEstimate(t *testing.T) {
	pool, ac, storyID := voteFixture(t)
	ctx := context.Background()

	var matches bool
	if err := pool.QueryRow(ctx,
		`select config = '{"deck":"fibonacci"}'::jsonb from sessions where id = $1`,
		ac.Session.ID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if !matches {
		t.Fatal("fixture config is not the legacy bare-name shape")
	}
	// Prove the bytes the handlers read are that shape too — jsonb equality
	// alone would still pass if ByID had rewritten them.
	var cfg Config
	if err := json.Unmarshal(ac.Session.Config, &cfg); err != nil {
		t.Fatalf("unmarshal fixture config: %v", err)
	}
	if cfg.ResolveDeck().Name != "fibonacci" {
		t.Fatalf("resolved deck = %q, want fibonacci", cfg.ResolveDeck().Name)
	}

	if rec := castFixtureVote(ac, storyID); rec.Code != http.StatusNoContent {
		t.Fatalf("vote: status = %d, want 204 (body %q)", rec.Code, strings.TrimSpace(rec.Body.String()))
	}

	revealRec := httptest.NewRecorder()
	reveal(revealRec, httptest.NewRequest(http.MethodPost, "/", nil), ac)
	if revealRec.Code != http.StatusNoContent {
		t.Fatalf("reveal: status = %d, want 204 (body %q)", revealRec.Code, strings.TrimSpace(revealRec.Body.String()))
	}

	estimate := "5"
	estRec := httptest.NewRecorder()
	applyPatch(estRec, httptest.NewRequest(http.MethodPatch, "/", nil), ac, storyID,
		patchBody{StoryID: storyID, Estimate: &estimate})
	if estRec.Code != http.StatusNoContent {
		t.Fatalf("estimate: status = %d, want 204 (body %q)", estRec.Code, strings.TrimSpace(estRec.Body.String()))
	}

	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, ac.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !sess.Revealed {
		t.Fatal("session was not revealed")
	}
	out, err := buildState(ctx, pool, sess)
	if err != nil {
		t.Fatalf("buildState after legacy reveal/estimate: %v", err)
	}
	st, ok := out.(State)
	if !ok {
		t.Fatalf("buildState returned %T, want State", out)
	}
	if len(st.Stories) == 0 || st.Stories[0].Estimate == nil || *st.Stories[0].Estimate != "5" {
		t.Fatalf("story estimate = %v, want 5", st.Stories)
	}
	if Deck(st.Deck).Name != "fibonacci" {
		t.Fatalf("state deck = %q, want fibonacci", Deck(st.Deck).Name)
	}
}
