package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The whole point of keeping the counter in Postgres: two replicas share one
// budget. Split the eight guesses across two routers backed by the same
// database and the ninth still has to be refused — with a per-process counter
// each replica hands out its own eight, so N replicas mean 8N guesses.
func TestPasscodeThrottleHoldsAcrossReplicas(t *testing.T) {
	pool := testPool(t)
	one := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	two := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})

	owner := signup(t, one, "Owner")
	doJSON(t, one, "POST", "/api/spaces", `{"name":"Split Room"}`, owner)
	guesser := signup(t, one, "Guesser")

	guess := func(srv *httptest.Server) int {
		resp, _ := doJSON(t, srv, "POST", "/api/orgs/default/spaces/split-room/join", `{"passcode":"ZZZZZZ"}`, guesser)
		return resp.StatusCode
	}

	for i := range passcodeAttemptLimit {
		srv := one
		if i%2 == 1 {
			srv = two
		}
		if got := guess(srv); got != http.StatusForbidden {
			t.Fatalf("guess %d: status %d, want %d", i+1, got, http.StatusForbidden)
		}
	}
	if got := guess(two); got != http.StatusTooManyRequests {
		t.Fatalf("the guess past the shared limit returned %d, want %d — the budget is per replica", got, http.StatusTooManyRequests)
	}
}

// A database that cannot count the guess cannot bound it either. The limiter
// has to refuse rather than wave the attempt through, so a Postgres outage
// cannot turn the throttle off for every replica at once.
func TestTakeRefusesWhenTheDatabaseErrors(t *testing.T) {
	l := newAttemptLimiter(testPool(t))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if l.take(ctx, "addr|space") {
		t.Fatal("a database error should refuse the attempt, not grant it")
	}
	if !l.blockedFor(ctx, "addr|space") {
		t.Fatal("a database error should not report an exhausted budget as available")
	}
}

// Every timestamp the limiter compares comes from Postgres, so replicas whose
// process clocks disagree still spend from one budget. With app-side clocks a
// fast replica writes a window_start in the future that the others honour, and
// its sweep deletes rows whose window has not actually elapsed — handing every
// guesser a fresh budget.
func TestThrottleIgnoresReplicaClockSkew(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	fast := newAttemptLimiter(pool)
	fast.now = func() time.Time { return time.Now().Add(90 * time.Second) }
	slow := newAttemptLimiter(pool)
	slow.now = func() time.Time { return time.Now().Add(-90 * time.Second) }

	// A bystander already part-way through its own window must survive whatever
	// the skewed replicas do next.
	if !slow.take(ctx, "bystander|space") {
		t.Fatal("the bystander's first guess should be allowed")
	}

	through := 0
	for i := range passcodeAttemptLimit * 2 {
		l := fast
		if i%2 == 1 {
			l = slow
		}
		if l.take(ctx, "addr|space") {
			through++
		}
	}
	if through != passcodeAttemptLimit {
		t.Fatalf("%d guesses got through a shared limit of %d — the replicas are counting on their own clocks", through, passcodeAttemptLimit)
	}

	var attempts int
	if err := pool.QueryRow(ctx, "select attempts from passcode_attempts where client_digest = $1",
		attemptDigest("bystander|space")).Scan(&attempts); err != nil {
		t.Fatalf("the bystander's live row was wiped by another replica's sweep: %v", err)
	}
}

// The refund a correct code earns is exactly one guess. Anything more and a
// caller who alternates a correct code with wrong ones guesses forever.
func TestRefundReturnsExactlyOneGuess(t *testing.T) {
	l := newAttemptLimiter(testPool(t))
	ctx := context.Background()

	for i := range passcodeAttemptLimit {
		if !l.take(ctx, "addr|space") {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
	}
	if l.take(ctx, "addr|space") {
		t.Fatal("the attempt past the limit should be refused")
	}

	l.refund(ctx, "addr|space")

	if !l.take(ctx, "addr|space") {
		t.Fatal("the refunded guess should be spendable again")
	}
	if l.take(ctx, "addr|space") {
		t.Fatal("one refund handed back more than one guess")
	}
}
