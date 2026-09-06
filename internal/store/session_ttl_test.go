package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
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

// The idle window and the absolute cap are two different arguments to the same
// query, and the tests above cannot tell them apart: they all run with
// IdleTTL == MaxTTL, so swapping the two placeholders leaves every one of them
// green. These two run the lifetimes far apart and in both orders, so a swap
// flips a verdict.
//
// distinctIdle/distinctMax are deliberately unequal by three orders of
// magnitude: with 2160h against 4h, a token the cap must refuse is nowhere
// near the idle window and vice versa.
const (
	distinctIdle = 2160 * time.Hour
	distinctMax  = 4 * time.Hour
)

// resolveVerdict says whether a token created createdHoursAgo and last used
// idleHours ago resolves under the given lifetimes.
func resolveVerdict(t *testing.T, users *Users, createdHoursAgo, idleHours int, label string) error {
	t.Helper()
	_, plain := newUser(t, users.Pool, label+" "+randSuffix(t))
	ageToken(t, users, plain, createdHoursAgo, idleHours)
	_, err := users.ResolveToken(context.Background(), mustHash(t, plain), true)
	return err
}

func TestResolveTokenKeepsTheIdleWindowAndTheCapApart(t *testing.T) {
	pool := testPool(t)

	// A short cap under a long idle window. Both tokens were used a moment
	// ago, so the idle window has nothing to say about either; only the 4h cap
	// separates them. Read with the arguments swapped, the 5h-old token would
	// be judged against 2160h and resolve.
	shortCap := &Users{Pool: pool, IdleTTL: distinctIdle, MaxTTL: distinctMax}
	if err := resolveVerdict(t, shortCap, 3, 0, "UnderCap"); err != nil {
		t.Errorf("a token created 3h ago and used just now, idle=2160h max=4h, was refused: %v", err)
	}
	if err := resolveVerdict(t, shortCap, 5, 0, "OverCap"); !errors.Is(err, ErrNoUser) {
		t.Errorf("a token created 5h ago and used just now, idle=2160h max=4h, resolved: err = %v, want ErrNoUser", err)
	}

	// The mirror: a short idle window under a long cap. Both tokens are 100h
	// old, well inside 2160h, so only the 4h idle window separates them.
	shortIdle := &Users{Pool: pool, IdleTTL: distinctMax, MaxTTL: distinctIdle}
	if err := resolveVerdict(t, shortIdle, 100, 3, "Active"); err != nil {
		t.Errorf("a token created 100h ago and used 3h ago, idle=4h max=2160h, was refused: %v", err)
	}
	if err := resolveVerdict(t, shortIdle, 100, 5, "Quiet"); !errors.Is(err, ErrNoUser) {
		t.Errorf("a token created 100h ago and used 5h ago, idle=4h max=2160h, resolved: err = %v, want ErrNoUser", err)
	}
}

// TokenExpiry takes the same two lifetimes and must order them the same way:
// it is what a live WebSocket enforces its deadline from, so a swap there
// would hold a socket open past the cap.
func TestTokenExpiryKeepsTheIdleWindowAndTheCapApart(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	expiryVerdict := func(users *Users, createdHoursAgo, idleHours int, label string) (time.Time, error) {
		t.Helper()
		_, plain := newUser(t, pool, label+" "+randSuffix(t))
		ageToken(t, users, plain, createdHoursAgo, idleHours)
		return users.TokenExpiry(ctx, mustHash(t, plain))
	}

	shortCap := &Users{Pool: pool, IdleTTL: distinctIdle, MaxTTL: distinctMax}
	// 3h old against a 4h cap: live, and the deadline is one hour out, not the
	// 2160h the idle window would give.
	expiresAt, err := expiryVerdict(shortCap, 3, 0, "CapSoon")
	if err != nil {
		t.Errorf("a token created 3h ago and used just now, idle=2160h max=4h, had no expiry: %v", err)
	} else if until := time.Until(expiresAt); until > 2*time.Hour {
		t.Errorf("expiry is %s out, want about 1h: the cap did not bound it", until)
	}
	if _, err := expiryVerdict(shortCap, 5, 0, "CapGone"); !errors.Is(err, ErrNoUser) {
		t.Errorf("a token created 5h ago and used just now, idle=2160h max=4h, still had an expiry: err = %v, want ErrNoUser", err)
	}

	shortIdle := &Users{Pool: pool, IdleTTL: distinctMax, MaxTTL: distinctIdle}
	if _, err := expiryVerdict(shortIdle, 100, 3, "IdleOK"); err != nil {
		t.Errorf("a token created 100h ago and used 3h ago, idle=4h max=2160h, had no expiry: %v", err)
	}
	if _, err := expiryVerdict(shortIdle, 100, 5, "IdleGone"); !errors.Is(err, ErrNoUser) {
		t.Errorf("a token created 100h ago and used 5h ago, idle=4h max=2160h, still had an expiry: err = %v, want ErrNoUser", err)
	}
}

// The sweep's predicate is the complement of the resolve clause and takes the
// same two lifetimes, so it needs the same guard: swapped, it would delete
// live sessions and spare dead ones.
func TestSweepKeepsTheIdleWindowAndTheCapApart(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	survives := func(plain string) bool {
		t.Helper()
		var count int
		if err := pool.QueryRow(ctx,
			"select count(*) from session_tokens where token_hash = $1", mustHash(t, plain)).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count == 1
	}

	// Short cap, long idle window: only the cap can condemn a row used a
	// moment ago.
	shortCap := &Users{Pool: pool, IdleTTL: distinctIdle, MaxTTL: distinctMax}
	_, keepCap := newUser(t, pool, "SweepUnderCap "+randSuffix(t))
	ageToken(t, shortCap, keepCap, 3, 0)
	_, dropCap := newUser(t, pool, "SweepOverCap "+randSuffix(t))
	ageToken(t, shortCap, dropCap, 5, 0)
	if _, err := shortCap.SweepExpiredTokens(ctx); err != nil {
		t.Fatal(err)
	}
	if !survives(keepCap) {
		t.Errorf("the sweep deleted a token created 3h ago and used just now under idle=2160h max=4h")
	}
	if survives(dropCap) {
		t.Errorf("the sweep spared a token created 5h ago under idle=2160h max=4h")
	}

	// The mirror: short idle window, long cap.
	shortIdle := &Users{Pool: pool, IdleTTL: distinctMax, MaxTTL: distinctIdle}
	_, keepIdle := newUser(t, pool, "SweepActive "+randSuffix(t))
	ageToken(t, shortIdle, keepIdle, 100, 3)
	_, dropIdle := newUser(t, pool, "SweepQuiet "+randSuffix(t))
	ageToken(t, shortIdle, dropIdle, 100, 5)
	if _, err := shortIdle.SweepExpiredTokens(ctx); err != nil {
		t.Fatal(err)
	}
	if !survives(keepIdle) {
		t.Errorf("the sweep deleted a token used 3h ago under idle=4h max=2160h")
	}
	if survives(dropIdle) {
		t.Errorf("the sweep spared a token used 5h ago under idle=4h max=2160h")
	}
}

// A rename is not a re-authentication. If the rotated row took a fresh
// created_at, whoever holds a stolen token could POST /me on a loop and stay
// signed in past SESSION_MAX_TTL forever.
func TestRenameDoesNotRestartTheAbsoluteLifetime(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	users := &Users{Pool: pool, IdleTTL: distinctIdle, MaxTTL: distinctMax}

	u, oldPlain := newUser(t, pool, "Renamer "+randSuffix(t))
	// One hour short of the 4h cap.
	ageToken(t, users, oldPlain, 3, 0)

	newPlain := "renamed-" + randSuffix(t)
	if _, err := users.Rename(ctx, u.ID, "Renamed "+randSuffix(t), mustHash(t, oldPlain), mustHash(t, newPlain)); err != nil {
		t.Fatal(err)
	}

	// Judged by an instance whose cap is 2h, the rotated token is already two
	// hours past its original deadline. It resolves only if the rename reset
	// created_at to now().
	tighter := &Users{Pool: pool, IdleTTL: distinctIdle, MaxTTL: 2 * time.Hour}
	if _, err := tighter.ResolveToken(ctx, mustHash(t, newPlain), true); !errors.Is(err, ErrNoUser) {
		t.Errorf("a token rotated by Rename outlived the original session's 3h-old created_at: err = %v, want ErrNoUser", err)
	}

	// Control: a token actually minted now is fine under the same 2h cap, so
	// the refusal above is the inherited created_at and not the cap alone.
	_, fresh := newUser(t, pool, "Fresh "+randSuffix(t))
	if _, err := tighter.ResolveToken(ctx, mustHash(t, fresh), true); err != nil {
		t.Errorf("a token minted just now was refused under a 2h cap: %v", err)
	}
}

// A redeemed link's own expires_at is the other deadline a rename must carry
// forward: dropped, the link session outlives the link.
func TestRenameCarriesTheTokenExpiryForward(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	users := &Users{Pool: pool}

	u, oldPlain := newUser(t, pool, "LinkRenamer "+randSuffix(t))
	if _, err := pool.Exec(ctx,
		"update session_tokens set expires_at = now() - interval '1 minute' where token_hash = $1",
		mustHash(t, oldPlain)); err != nil {
		t.Fatal(err)
	}

	newPlain := "link-renamed-" + randSuffix(t)
	if _, err := users.Rename(ctx, u.ID, "Link Renamed "+randSuffix(t), mustHash(t, oldPlain), mustHash(t, newPlain)); err != nil {
		t.Fatal(err)
	}
	if _, err := users.ResolveToken(ctx, mustHash(t, newPlain), true); !errors.Is(err, ErrNoUser) {
		t.Errorf("a rename dropped the token's own expires_at: err = %v, want ErrNoUser", err)
	}
}

// A rename whose old hash is already gone must not mint a replacement on a
// fresh clock. That is the coalesce(min(created_at), now()) hole: zero matching
// rows made min() null and the insert succeeded with created_at = now(), which
// is how a stolen token could outlive SESSION_MAX_TTL by POSTing /me in a loop.
func TestRenameWithUnknownTokenHashInsertsNothing(t *testing.T) {
	pool := testPool(t)
	users := &Users{Pool: pool}
	ctx := context.Background()

	u, oldPlain := newUser(t, pool, "Known "+randSuffix(t))
	oldHash := mustHash(t, oldPlain)
	_, unknownHash := NewToken()
	_, newHash := NewToken()

	if _, err := users.Rename(ctx, u.ID, "Hijacked "+randSuffix(t), unknownHash, newHash); !errors.Is(err, ErrNoUser) {
		t.Fatalf("rename with an unknown token hash: err = %v, want ErrNoUser", err)
	}

	var count int
	if err := pool.QueryRow(ctx,
		"select count(*) from session_tokens where user_id = $1", u.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("rename with an unknown hash left %d token rows, want 1", count)
	}
	var inserted int
	if err := pool.QueryRow(ctx,
		"select count(*) from session_tokens where token_hash = $1", newHash).Scan(&inserted); err != nil {
		t.Fatal(err)
	}
	if inserted != 0 {
		t.Errorf("rename with an unknown hash inserted the new token")
	}

	got, err := users.ByToken(ctx, oldHash)
	if err != nil {
		t.Fatalf("the original token was disturbed: %v", err)
	}
	if got.ID != u.ID {
		t.Errorf("the original token now resolves to %s, want %s", got.ID, u.ID)
	}
	if got.Name != u.Name {
		t.Errorf("a failed rename still wrote the name: got %q, want %q", got.Name, u.Name)
	}
}

// Two POST /api/me requests carrying the same cookie both pass resolvePrincipal,
// then serialize on the users row. The first rename deletes the old hash; the
// second used to insert with min(created_at) over zero rows, i.e. now(). The
// surviving row must keep the original created_at, and the loser must not mint
// a second session.
func TestConcurrentRenamesKeepTheOriginalCreatedAt(t *testing.T) {
	pool := testPool(t)
	users := &Users{Pool: pool}
	ctx := context.Background()

	u, oldPlain := newUser(t, pool, "Racer "+randSuffix(t))
	oldHash := mustHash(t, oldPlain)
	ageToken(t, users, oldPlain, 3, 0)

	var original time.Time
	if err := pool.QueryRow(ctx,
		"select created_at from session_tokens where token_hash = $1", oldHash).Scan(&original); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	outcomes := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		_, newHash := NewToken()
		name := fmt.Sprintf("Renamed %d %s", i, randSuffix(t))
		wg.Add(1)
		go func(name string, newHash []byte) {
			defer wg.Done()
			<-start
			_, err := users.Rename(ctx, u.ID, name, oldHash, newHash)
			outcomes <- err
		}(name, newHash)
	}
	close(start)
	wg.Wait()
	close(outcomes)

	succeeded := 0
	for err := range outcomes {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrNoUser):
		default:
			t.Fatalf("concurrent rename: unexpected error: %v", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("concurrent renames succeeded %d times, want 1", succeeded)
	}

	var count int
	var createdAt time.Time
	if err := pool.QueryRow(ctx, `
		select count(*), min(created_at)
		from session_tokens where user_id = $1`, u.ID).Scan(&count, &createdAt); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("user has %d token rows after concurrent rename, want 1", count)
	}
	delta := createdAt.Sub(original)
	if delta < 0 {
		delta = -delta
	}
	if delta > time.Second {
		t.Errorf("surviving token created_at = %s, want the original %s", createdAt, original)
	}
}

// The first sweep on an instance upgraded from the pre-TTL builds can match
// far more rows than one statement should delete, so the sweep loops. Without
// the loop this leaves 1500 dead rows behind.
func TestSweepDrainsABacklogLargerThanOneBatch(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	users := &Users{Pool: pool, IdleTTL: distinctIdle, MaxTTL: distinctMax}

	// 2500 against a batch of 1000: two full passes and a short one.
	const backlog = 2500
	marker := randSuffix(t)
	if _, err := pool.Exec(ctx, `
		with u as (
			insert into users (name)
			select $1 || ' ' || g from generate_series(1, $2) g
			returning id
		)
		insert into session_tokens (token_hash, user_id, created_at, last_used_at)
		select sha256(id::text::bytea), id, now() - interval '5 hours', now()
		from u`, "Backlog "+marker, backlog); err != nil {
		t.Fatal(err)
	}

	remaining := func() int {
		t.Helper()
		var count int
		if err := pool.QueryRow(ctx, `
			select count(*) from session_tokens t
			join users u on u.id = t.user_id
			where u.name like $1`, "Backlog "+marker+" %").Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	if got := remaining(); got != backlog {
		t.Fatalf("seeded %d backlog rows, want %d", got, backlog)
	}

	if _, err := users.SweepExpiredTokens(ctx); err != nil {
		t.Fatal(err)
	}
	if got := remaining(); got != 0 {
		t.Errorf("%d of %d expired rows survived one sweep call", got, backlog)
	}
}
