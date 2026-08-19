package store

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// newSession creates a space, joins every named member, and opens a session
// facilitated by the first one. It returns the session and the members in the
// order given.
func newSession(t *testing.T, pool *pgxpool.Pool, names ...string) (Session, []User) {
	t.Helper()
	ctx := context.Background()
	sp := newSpace(t, pool)
	spaces := &Spaces{Pool: pool}

	var members []User
	for _, n := range names {
		u, _ := newUser(t, pool, n)
		if err := spaces.Join(ctx, sp.ID, u.ID); err != nil {
			t.Fatal(err)
		}
		members = append(members, u)
	}
	sess, err := (&Sessions{Pool: pool}).Create(ctx, sp.ID, "poker", "Sprint 12", []byte(`{}`), members[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	return sess, members
}

// staleFacilitator backdates facilitator_seen_at past the grace period, so a
// claim becomes eligible without the test sleeping for a minute.
func staleFacilitator(t *testing.T, pool *pgxpool.Pool, sessionID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		"update sessions set facilitator_seen_at = now() - $2::interval * 2 where id = $1",
		sessionID, FacilitatorGrace); err != nil {
		t.Fatal(err)
	}
}

func TestSessionByIDAndListBySpace(t *testing.T) {
	pool := testPool(t)
	sessions := &Sessions{Pool: pool}
	ctx := context.Background()

	sess, members := newSession(t, pool, "Dana Whitfield")
	got, err := sessions.ByID(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != sess.ID || got.Kind != "poker" || got.FacilitatorID != members[0].ID {
		t.Fatalf("ByID = %+v, want the session just created", got)
	}

	list, err := sessions.ListBySpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != sess.ID {
		t.Fatalf("ListBySpace returned %d sessions, want just %s", len(list), sess.ID)
	}

	if _, err := sessions.ByID(ctx, "00000000-0000-4000-8000-000000000000"); err != ErrNoSession {
		t.Fatalf("missing session: got %v, want ErrNoSession", err)
	}
}

func TestClaimFacilitatorNeedsAStaleSeat(t *testing.T) {
	pool := testPool(t)
	sessions := &Sessions{Pool: pool}
	ctx := context.Background()

	sess, members := newSession(t, pool, "Dana Whitfield", "Ben Alvarez")
	facilitator, claimer := members[0], members[1]

	// The facilitator was seen at creation, so the seat is not up for grabs.
	if err := sessions.ClaimFacilitator(ctx, sess.ID, claimer.ID); err != ErrNotEligible {
		t.Fatalf("claim against a live facilitator: got %v, want ErrNotEligible", err)
	}

	staleFacilitator(t, pool, sess.ID)
	if err := sessions.ClaimFacilitator(ctx, sess.ID, claimer.ID); err != nil {
		t.Fatalf("claim against a stale facilitator: %v", err)
	}
	got, err := sessions.ByID(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.FacilitatorID != claimer.ID {
		t.Fatalf("facilitator = %s, want the claimer %s", got.FacilitatorID, claimer.ID)
	}
	if got.Version <= sess.Version {
		t.Fatalf("version = %d, want a bump over %d", got.Version, sess.Version)
	}

	// Claiming a seat you already hold is a no-op, not a second grant. Go
	// stale first so the grace-period clause is satisfied and the refusal can
	// only come from the facilitator_id <> claimer check.
	staleFacilitator(t, pool, sess.ID)
	if err := sessions.ClaimFacilitator(ctx, sess.ID, claimer.ID); err != ErrNotEligible {
		t.Fatalf("self-claim on a stale seat: got %v, want ErrNotEligible", err)
	}

	// Touching liveness closes the window again.
	staleFacilitator(t, pool, sess.ID)
	if err := sessions.TouchFacilitatorSeen(ctx, sess.ID, claimer.ID); err != nil {
		t.Fatal(err)
	}
	if err := sessions.ClaimFacilitator(ctx, sess.ID, facilitator.ID); err != ErrNotEligible {
		t.Fatalf("claim after a touch: got %v, want ErrNotEligible", err)
	}
}

func TestTouchFacilitatorSeenIgnoresNonFacilitators(t *testing.T) {
	pool := testPool(t)
	sessions := &Sessions{Pool: pool}
	ctx := context.Background()

	sess, members := newSession(t, pool, "Dana Whitfield", "Ben Alvarez")
	staleFacilitator(t, pool, sess.ID)

	// A member who is not the facilitator must not be able to keep the seat
	// warm on the facilitator's behalf.
	if err := sessions.TouchFacilitatorSeen(ctx, sess.ID, members[1].ID); err != nil {
		t.Fatal(err)
	}
	if err := sessions.ClaimFacilitator(ctx, sess.ID, members[1].ID); err != nil {
		t.Fatalf("seat should still be claimable: %v", err)
	}
}

func TestClaimFacilitatorHasExactlyOneWinner(t *testing.T) {
	pool := testPool(t)
	sessions := &Sessions{Pool: pool}

	sess, members := newSession(t, pool, "Dana Whitfield", "Ben Alvarez", "Priya Raman", "Tomas Herrera")
	staleFacilitator(t, pool, sess.ID)

	claimers := members[1:]
	results := make([]error, len(claimers))
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i, m := range claimers {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			<-start
			results[i] = sessions.ClaimFacilitator(context.Background(), sess.ID, id)
		}(i, m.ID)
	}
	close(start)
	wg.Wait()

	won := 0
	for i, err := range results {
		switch err {
		case nil:
			won++
		case ErrNotEligible:
		default:
			t.Fatalf("claimer %d: unexpected error %v", i, err)
		}
	}
	if won != 1 {
		t.Fatalf("%d claimers won the seat, want exactly 1", won)
	}
}

func TestTransferFacilitatorRequiresMembership(t *testing.T) {
	pool := testPool(t)
	sessions := &Sessions{Pool: pool}
	ctx := context.Background()

	sess, members := newSession(t, pool, "Dana Whitfield", "Ben Alvarez")
	outsider, _ := newUser(t, pool, "Nina Kowalski")

	if err := sessions.TransferFacilitator(ctx, sess.ID, outsider.ID); err != ErrNotEligible {
		t.Fatalf("transfer to a non-member: got %v, want ErrNotEligible", err)
	}
	unchanged, err := sessions.ByID(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.FacilitatorID != members[0].ID {
		t.Fatalf("facilitator changed to %s on a rejected transfer", unchanged.FacilitatorID)
	}

	if err := sessions.TransferFacilitator(ctx, sess.ID, members[1].ID); err != nil {
		t.Fatalf("transfer to a member: %v", err)
	}
	got, err := sessions.ByID(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.FacilitatorID != members[1].ID {
		t.Fatalf("facilitator = %s, want %s", got.FacilitatorID, members[1].ID)
	}
	if got.Version <= sess.Version {
		t.Fatalf("version = %d, want a bump over %d", got.Version, sess.Version)
	}
	// The new facilitator's seat is fresh, so nobody can claim it.
	if err := sessions.ClaimFacilitator(ctx, sess.ID, members[0].ID); err != ErrNotEligible {
		t.Fatalf("claim right after a transfer: got %v, want ErrNotEligible", err)
	}
}

func TestSetEndedAndBumpVersion(t *testing.T) {
	pool := testPool(t)
	sessions := &Sessions{Pool: pool}
	ctx := context.Background()

	sess, _ := newSession(t, pool, "Dana Whitfield")
	if sess.EndedAt != nil {
		t.Fatal("a new session is already ended")
	}
	if err := sessions.SetEnded(ctx, sess.ID, true); err != nil {
		t.Fatal(err)
	}
	ended, err := sessions.ByID(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ended.EndedAt == nil {
		t.Fatal("EndedAt is nil after SetEnded(true)")
	}

	// Reopening clears it again — the UI offers this after an accidental end.
	if err := sessions.SetEnded(ctx, sess.ID, false); err != nil {
		t.Fatal(err)
	}
	reopened, err := sessions.ByID(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.EndedAt != nil {
		t.Fatalf("EndedAt = %v after SetEnded(false), want nil", reopened.EndedAt)
	}
	if reopened.Version <= ended.Version {
		t.Fatalf("version = %d, want a bump over %d", reopened.Version, ended.Version)
	}

	if err := sessions.BumpVersion(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}
	bumped, err := sessions.ByID(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if bumped.Version != reopened.Version+1 {
		t.Fatalf("version = %d, want %d", bumped.Version, reopened.Version+1)
	}
}

func TestSessionOfARetiredKindStillLoads(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	kind := "retro-" + randSuffix(t)
	if _, err := pool.Exec(ctx,
		"insert into session_kinds (kind, provider, display) values ($1, 'test', 'Retro')", kind); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		// Sessions of this kind must go first: the foreign key is RESTRICT,
		// so the kind row can't be removed while one still references it.
		if _, err := pool.Exec(cleanupCtx, "delete from sessions where kind = $1", kind); err != nil {
			t.Errorf("cleaning up sessions of kind %q: %v", kind, err)
			return
		}
		if _, err := pool.Exec(cleanupCtx, "delete from session_kinds where kind = $1", kind); err != nil {
			t.Errorf("cleaning up session_kinds row: %v", err)
		}
	})

	sp := newSpace(t, pool)
	u, _ := newUser(t, pool, "Priya Raman")
	sessions := &Sessions{Pool: pool}
	sess, err := sessions.Create(ctx, sp.ID, kind, "Retro", []byte(`{}`), u.ID)
	if err != nil {
		t.Fatal(err)
	}

	// A kind with sessions is retired in place. Hard-deleting it must be
	// refused, or the history it belongs to loses its reference.
	_, err = pool.Exec(ctx, "delete from session_kinds where kind = $1", kind)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("deleting a kind that has sessions: got %v, want a foreign_key_violation (23503)", err)
	}
	if _, err := pool.Exec(ctx,
		"update session_kinds set retired_at = now() where kind = $1", kind); err != nil {
		t.Fatal(err)
	}

	got, err := sessions.ByID(ctx, sess.ID)
	if err != nil {
		t.Fatalf("loading a session of a retired kind: %v", err)
	}
	if got.Kind != kind {
		t.Fatalf("kind = %q, want %q", got.Kind, kind)
	}
}

func TestSessionRejectsAnUnknownKind(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	sp := newSpace(t, pool)
	u, _ := newUser(t, pool, "Ben Alvarez")
	_, err := (&Sessions{Pool: pool}).Create(ctx, sp.ID, "no-such-kind", "Nope", []byte(`{}`), u.ID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("creating a session of an unregistered kind: got %v, want a foreign_key_violation (23503)", err)
	}
}
