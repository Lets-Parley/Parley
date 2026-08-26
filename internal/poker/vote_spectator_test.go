package poker

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/db"
	"github.com/lets-parley/parley/internal/dbtest"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// voteFixture builds the smallest room a vote can land in: a space, a member,
// a poker session with one story selected.
func voteFixture(t *testing.T) (*pgxpool.Pool, session.ActionCtx, string) {
	t.Helper()
	return voteFixtureTraced(t, nil)
}

// voteFixtureTraced is voteFixture with an optional pgx.QueryTracer wired into
// the pool the fixture and the handler under test both use. A tracer lets a
// test induce a query failure at the Go layer — a poisoned context for one
// specific statement — instead of mutating the shared schema, which would
// leak into every other test on the same database.
func voteFixtureTraced(t *testing.T, tracer pgx.QueryTracer) (*pgxpool.Pool, session.ActionCtx, string) {
	t.Helper()
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	if tracer != nil {
		cfg.ConnConfig.Tracer = tracer
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, "drop schema public cascade; create schema public"); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, pool, slog.New(slog.NewTextHandler(os.Stderr, nil)), db.MigrationsFS); err != nil {
		t.Fatal(err)
	}

	var userID, spaceID, sessionID, storyID string
	must := func(q string, dest *string, args ...any) {
		t.Helper()
		if err := pool.QueryRow(ctx, q, args...).Scan(dest); err != nil {
			t.Fatal(err)
		}
	}
	must("insert into users (name) values ('Voter') returning id::text", &userID)
	must("insert into spaces (slug, name) values ('room', 'Room') returning id::text", &spaceID)
	must(`insert into sessions (space_id, kind, title, config, facilitator_id)
		values ($1, 'poker', 'Sizing', '{"deck":"fibonacci"}', $2) returning id::text`, &sessionID, spaceID, userID)
	must("insert into stories (session_id, title, position) values ($1, 'Login', 1) returning id::text",
		&storyID, sessionID)
	if _, err := pool.Exec(ctx, "update sessions set current_story_id = $1 where id = $2", storyID, sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into members (space_id, user_id) values ($1, $2)", spaceID, userID); err != nil {
		t.Fatal(err)
	}

	sess, err := (&store.Sessions{Pool: pool}).ByID(ctx, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	ac := session.ActionCtx{
		Pool:      pool,
		Presence:  &store.Presence{Pool: pool, ReplicaID: "test", Window: time.Minute},
		Broadcast: func(context.Context, string) {},
		Session:   sess,
		UserID:    userID,
	}
	return pool, ac, storyID
}

func castFixtureVote(ac session.ActionCtx, storyID string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	castVote(rec, req, ac, storyID, "5")
	return rec
}

// cancelOnQuery is a pgx.QueryTracer that hands a pre-cancelled context to
// any query whose SQL contains match, leaving every other query on the same
// pool untouched. It reproduces a transport fault (a cancelled context, a
// closed or poisoned pool) for one specific statement without touching the
// database's schema, so it can't leak damage into other tests the way
// dropping a column would.
type cancelOnQuery struct {
	match string
}

func (c cancelOnQuery) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, c.match) {
		cctx, cancel := context.WithCancel(ctx)
		cancel()
		return cctx
	}
	return ctx
}

func (c cancelOnQuery) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// A failing spectator lookup is a server fault, not a permission decision:
// reporting it as "spectators cannot vote" hides a database outage behind a
// 409 that no dashboard is watching.
func TestVoteReportsDatabaseErrorNotSpectator(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	_, ac, storyID := voteFixtureTraced(t, cancelOnQuery{match: "from members where space_id"})

	rec := castFixtureVote(ac, storyID)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %q)", rec.Code, strings.TrimSpace(rec.Body.String()))
	}
	if strings.Contains(rec.Body.String(), "spectators cannot vote") {
		t.Fatalf("body leaked the spectator refusal message: %q", rec.Body.String())
	}
	if !strings.Contains(logs.String(), "reading spectator flag") {
		t.Fatalf("expected the spectator lookup failure to be logged, got %q", logs.String())
	}
}

func TestVoteRefusesSpectator(t *testing.T) {
	pool, ac, storyID := voteFixture(t)
	if _, err := pool.Exec(context.Background(),
		"update members set spectator = true where user_id = $1", ac.UserID); err != nil {
		t.Fatal(err)
	}

	rec := castFixtureVote(ac, storyID)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "spectators cannot vote") {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

// A guest who joined by signed link has no members row: no row is a plain
// participant, not a refusal.
func TestVoteAllowsNonMember(t *testing.T) {
	pool, ac, storyID := voteFixture(t)
	if _, err := pool.Exec(context.Background(), "delete from members where user_id = $1", ac.UserID); err != nil {
		t.Fatal(err)
	}

	if rec := castFixtureVote(ac, storyID); rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", rec.Code, strings.TrimSpace(rec.Body.String()))
	}
}
