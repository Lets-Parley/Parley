package poker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/lets-parley/parley/internal/store"
)

// capturingTracer records every SQL string the pool runs so a test can pin
// the shape of the open-voting reveal check without asserting timings.
type capturingTracer struct {
	mu   sync.Mutex
	sqls []string
}

func (c *capturingTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	c.mu.Lock()
	c.sqls = append(c.sqls, data.SQL)
	c.mu.Unlock()
	return ctx
}

func (c *capturingTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (c *capturingTracer) all() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, len(c.sqls))
	copy(out, c.sqls)
	return out
}

func (c *capturingTracer) reset() {
	c.mu.Lock()
	c.sqls = nil
	c.mu.Unlock()
}

// The open-voting reveal check used to rebuild the eligible set inside every
// vote — a CTE over round_voters with per-row EXISTS probes against members
// and session_links. That shape must not reappear on the vote path: departed
// members and revoked links are pruned when membership changes, and the vote
// only asks whether every still-pending recorded voter has cast.
func TestOpenVotingRevealCheckSkipsEligibleSetCTE(t *testing.T) {
	tracer := &capturingTracer{}
	pool, ac, storyID := voteFixtureTraced(t, tracer)
	ctx := context.Background()

	// Open voting on, auto-reveal on, and the voter recorded as a participant
	// so the round has somebody to wait for.
	if _, err := pool.Exec(ctx,
		`update sessions set config = '{"deck":"fibonacci","autoReveal":true,"openVoting":true}' where id = $1`,
		ac.Session.ID); err != nil {
		t.Fatal(err)
	}
	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, ac.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	ac.Session = sess
	if err := ac.Presence.Join(ctx, ac.Session.ID, ac.UserID); err != nil {
		t.Fatal(err)
	}
	err = (&store.Sessions{Pool: pool}).WithActiveSession(ctx, ac.Session.ID, ac.UserID, true,
		func(tx pgx.Tx, sess store.Session) error {
			return snapshotVoters(ctx, tx, sess, storyID)
		})
	if err != nil {
		t.Fatal(err)
	}

	tracer.reset()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	castVote(rec, req, ac, storyID, "5")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("vote: %d %s", rec.Code, rec.Body.String())
	}

	for _, sql := range tracer.all() {
		lower := strings.ToLower(sql)
		if strings.Contains(lower, "with expected as") {
			t.Fatalf("vote path still runs the eligible-set CTE:\n%s", sql)
		}
		// The completion check must not re-probe session_links per voter.
		if strings.Contains(lower, "round_voters") && strings.Contains(lower, "session_links") &&
			strings.Contains(lower, "select exists") {
			t.Fatalf("vote path still intersects round_voters with session_links:\n%s", sql)
		}
	}
}

// snapshotVoters must not copy an unbounded session_participants table into
// round_voters. A room that has accumulated more joiners than the cap still
// records only the cap.
func TestSnapshotVotersCapsTheRoster(t *testing.T) {
	pool, ac, storyID := voteFixture(t)
	ctx := context.Background()

	old := store.MaxSessionParticipantsForTest()
	store.SetMaxSessionParticipantsForTest(3)
	t.Cleanup(func() { store.SetMaxSessionParticipantsForTest(old) })

	if _, err := pool.Exec(ctx,
		`update sessions set config = '{"deck":"fibonacci","openVoting":true}' where id = $1`,
		ac.Session.ID); err != nil {
		t.Fatal(err)
	}
	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, ac.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	ac.Session = sess

	for i := 0; i < 5; i++ {
		var uid string
		if err := pool.QueryRow(ctx, "insert into users (name) values ($1) returning id::text", "Extra").Scan(&uid); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx,
			`insert into session_participants (session_id, user_id, joined_at)
			 values ($1, $2, now() - ($3 * interval '1 second'))`,
			ac.Session.ID, uid, 10-i); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx,
			"insert into members (space_id, user_id) values ($1, $2)", ac.Session.SpaceID, uid); err != nil {
			t.Fatal(err)
		}
	}

	err = (&store.Sessions{Pool: pool}).WithActiveSession(ctx, ac.Session.ID, ac.UserID, true,
		func(tx pgx.Tx, sess store.Session) error {
			return snapshotVoters(ctx, tx, sess, storyID)
		})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, "select count(*) from round_voters where story_id = $1", storyID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("snapshot recorded %d voters, want the cap of 3", n)
	}
}
