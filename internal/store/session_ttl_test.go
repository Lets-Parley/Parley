package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The two lifetimes under test, written out rather than derived from the
// package defaults: a test that reads its own bound from the code under test
// passes for whatever that code happens to do.
const (
	testIdleTTL = 2160 * time.Hour // 90 days
	testMaxTTL  = 2160 * time.Hour
)

func mustHash(t *testing.T, plain string) []byte {
	t.Helper()
	hash, err := HashToken(plain)
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

// ageToken backdates one token's created_at and last_used_at by the given
// numbers of hours, so a lifetime measured in days can be pinned in one
// statement instead of waited out.
func ageToken(t *testing.T, users *Users, plain string, createdHoursAgo, idleHours int) {
	t.Helper()
	hash := mustHash(t, plain)
	tag, err := users.Pool.Exec(context.Background(), `
		update session_tokens
		set created_at = now() - make_interval(hours => $2),
		    last_used_at = now() - make_interval(hours => $3)
		where token_hash = $1`, hash, createdHoursAgo, idleHours)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("backdated %d token rows, want 1", tag.RowsAffected())
	}
}

func TestSessionAbsoluteLifetimeEndsAnActiveToken(t *testing.T) {
	pool := testPool(t)
	users := &Users{Pool: pool, IdleTTL: testIdleTTL, MaxTTL: testMaxTTL}
	ctx := context.Background()

	// 2161h old against a 2160h cap, and used one second ago: only the
	// absolute lifetime can refuse this token.
	_, plain := newUser(t, pool, "Stale "+randSuffix(t))
	ageToken(t, users, plain, 2161, 0)
	if _, err := users.ResolveToken(ctx, mustHash(t, plain), true); !errors.Is(err, ErrNoUser) {
		t.Errorf("a token created 2161h ago with SESSION_MAX_TTL=2160h resolved: err = %v, want ErrNoUser", err)
	}

	// One hour inside the cap, on the same idle history: still usable, so the
	// refusal above is the cap and not the backdating.
	_, live := newUser(t, pool, "Fresh "+randSuffix(t))
	ageToken(t, users, live, 2159, 0)
	if _, err := users.ResolveToken(ctx, mustHash(t, live), true); err != nil {
		t.Errorf("a token created 2159h ago with SESSION_MAX_TTL=2160h was refused: %v", err)
	}
}

func TestSessionIdleLifetimeIsConfigurable(t *testing.T) {
	pool := testPool(t)
	// A one-hour idle window against a 2160h absolute cap: whatever refuses
	// the token below, it is not the cap.
	users := &Users{Pool: pool, IdleTTL: time.Hour, MaxTTL: testMaxTTL}
	ctx := context.Background()

	_, plain := newUser(t, pool, "Idle "+randSuffix(t))
	ageToken(t, users, plain, 2, 2)
	if _, err := users.ResolveToken(ctx, mustHash(t, plain), true); !errors.Is(err, ErrNoUser) {
		t.Errorf("a token idle 2h with SESSION_IDLE_TTL=1h resolved: err = %v, want ErrNoUser", err)
	}

	_, live := newUser(t, pool, "Busy "+randSuffix(t))
	if _, err := users.ResolveToken(ctx, mustHash(t, live), true); err != nil {
		t.Errorf("a token used just now with SESSION_IDLE_TTL=1h was refused: %v", err)
	}
}

func TestSweepExpiredTokensDeletesOnlyDeadRows(t *testing.T) {
	pool := testPool(t)
	users := &Users{Pool: pool, IdleTTL: testIdleTTL, MaxTTL: testMaxTTL}
	ctx := context.Background()

	_, tooOld := newUser(t, pool, "TooOld "+randSuffix(t))
	ageToken(t, users, tooOld, 2161, 0)
	_, tooIdle := newUser(t, pool, "TooIdle "+randSuffix(t))
	ageToken(t, users, tooIdle, 2161, 2161)
	_, live := newUser(t, pool, "Live "+randSuffix(t))
	ageToken(t, users, live, 2159, 1)

	if _, err := users.SweepExpiredTokens(ctx); err != nil {
		t.Fatal(err)
	}

	for _, plain := range []string{tooOld, tooIdle} {
		var count int
		if err := pool.QueryRow(ctx,
			"select count(*) from session_tokens where token_hash = $1", mustHash(t, plain)).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Errorf("an expired token row survived the sweep")
		}
	}
	var count int
	if err := pool.QueryRow(ctx,
		"select count(*) from session_tokens where token_hash = $1", mustHash(t, live)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("the sweep deleted a token 2159h old and idle 1h under a 2160h/2160h policy")
	}
}
