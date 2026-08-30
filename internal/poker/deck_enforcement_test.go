package poker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/session"
)

// setSessionDeck rewrites the fixture session's config so the handlers under
// test resolve a deck other than the fibonacci default.
func setSessionDeck(t *testing.T, pool *pgxpool.Pool, sessionID, config string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		"update sessions set config = $2 where id = $1", sessionID, config); err != nil {
		t.Fatal(err)
	}
}

func castVoteValue(ac session.ActionCtx, storyID, value string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	castVote(rec, httptest.NewRequest(http.MethodPost, "/", nil), ac, storyID, value)
	return rec
}

// A vote is checked against the session's own deck. "5" is a fibonacci card
// and not a tshirt one, so a session playing tshirt has to refuse it — a
// handler hardwired to fibonacci would accept it.
func TestVoteRejectsCardFromAnotherDeck(t *testing.T) {
	pool, ac, storyID := voteFixture(t)
	setSessionDeck(t, pool, ac.Session.ID, `{"deck":"tshirt"}`)

	rec := castVoteValue(ac, storyID, "5")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %q)", rec.Code, strings.TrimSpace(rec.Body.String()))
	}
	if !strings.Contains(rec.Body.String(), "not in this session's deck") {
		t.Fatalf("body = %q", rec.Body.String())
	}

	if rec := castVoteValue(ac, storyID, "M"); rec.Code != http.StatusNoContent {
		t.Fatalf("tshirt card M: status = %d, want 204 (body %q)", rec.Code, strings.TrimSpace(rec.Body.String()))
	}
}

// The same rule on the estimate path. "34" is fibonacci-only; "40" is
// modified-fibonacci-only.
func TestEstimateRejectsCardFromAnotherDeck(t *testing.T) {
	pool, ac, storyID := voteFixture(t)
	setSessionDeck(t, pool, ac.Session.ID, `{"deck":"modified-fibonacci"}`)

	patch := func(estimate string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		applyPatch(rec, httptest.NewRequest(http.MethodPatch, "/", nil), ac, storyID,
			patchBody{StoryID: storyID, Estimate: &estimate})
		return rec
	}

	rec := patch("34")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, strings.TrimSpace(rec.Body.String()))
	}
	if !strings.Contains(rec.Body.String(), "a card from this session's deck") {
		t.Fatalf("body = %q", rec.Body.String())
	}

	if rec := patch("40"); rec.Code != http.StatusNoContent {
		t.Fatalf("modified-fibonacci card 40: status = %d, want 204 (body %q)", rec.Code, strings.TrimSpace(rec.Body.String()))
	}
}
