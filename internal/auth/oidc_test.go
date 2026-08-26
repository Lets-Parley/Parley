package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

func TestDisplayNamePrefersFriendliestClaim(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []string
		want string
	}{
		{"full name wins", []string{"Dana Whitlock", "dwhitlock", "dana@example.com", "sub-1"}, "Dana Whitlock"},
		{"falls back to username", []string{"", "dwhitlock", "dana@example.com", "sub-1"}, "dwhitlock"},
		{"email loses its domain", []string{"", "", "dana@example.com", "sub-1"}, "dana"},
		{"subject is the last resort", []string{"", "", "", "sub-1"}, "sub-1"},
		{"nothing at all still names someone", []string{"", "", "", ""}, "Someone"},
		// The users table caps names at 64 characters; a provider that sends a
		// longer one must not turn every sign-in into a failed insert.
		{"over-long names are cut to fit the column", []string{strings.Repeat("a", 100)}, strings.Repeat("a", 64)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := displayName(tc.in...); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDisplayNameTruncatesWithoutSplittingARune(t *testing.T) {
	// "い" is three bytes, so byte 64 of a 100-rune name lands in the middle of
	// a rune. Postgres rejects invalid UTF-8 in a text column, which would turn
	// every sign-in for this user into a failed insert.
	got := displayName(strings.Repeat("い", 100))
	want := strings.Repeat("い", 64)
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("got invalid UTF-8: %q", got)
	}
	if n := utf8.RuneCountInString(got); n != 64 {
		t.Errorf("got %d runes, want 64", n)
	}
}

func TestDisplayNameStripsControlCharacters(t *testing.T) {
	// A raw NUL is valid UTF-8 (utf8.ValidString accepts it), but Postgres
	// refuses a text column containing one outright, producing the same
	// sign-in 500 this package exists to prevent.
	got := displayName("al\x00ice")
	if strings.ContainsRune(got, 0) {
		t.Fatalf("got %q, want the NUL stripped", got)
	}
	if got != "alice" {
		t.Errorf("got %q, want %q", got, "alice")
	}
}

func TestDisplayNameTrimsTrailingSpaceAfterTruncation(t *testing.T) {
	got := displayName(strings.Repeat("a", 63) + " " + strings.Repeat("a", 36))
	if strings.HasSuffix(got, " ") {
		t.Fatalf("got %q, want no trailing space", got)
	}
	if n := utf8.RuneCountInString(got); n != 63 {
		t.Errorf("got %d runes, want 63", n)
	}
}

func TestDisplayNameSkipsAnAllWhitespaceCandidate(t *testing.T) {
	got := displayName(strings.Repeat(" ", 100), "", "", "sub-1")
	if got != "sub-1" {
		t.Errorf("got %q, want %q", got, "sub-1")
	}
}

func TestDisplayNameSkipsACandidateThatBecomesEmptyAfterStripping(t *testing.T) {
	// "\x00" is non-empty and non-whitespace, so it survives the leading
	// TrimSpace check, but control-character stripping reduces it to "" -
	// that candidate must still be skipped in favor of the next one.
	got := displayName("\x00", "", "", "sub-1")
	if got != "sub-1" {
		t.Errorf("got %q, want %q", got, "sub-1")
	}
}

func TestIssuerReturnsConfiguredIssuer(t *testing.T) {
	p := providerFor(t, "https://idp.example.test")
	if got := p.Issuer(); got != "https://idp.example.test" {
		t.Errorf("got %q, want %q", got, "https://idp.example.test")
	}
}

func TestExchangeAcceptsAMatchingNonce(t *testing.T) {
	idp := newFakeIdP(t)
	idp.nonce = "the-nonce"
	p := providerFor(t, idp.URL)

	id, err := p.Exchange(context.Background(), "code", "verifier", "the-nonce")
	if err != nil {
		t.Fatalf("exchanging a well-formed sign-in: %v", err)
	}
	if id.Subject != "user-1" || id.Name != "Dana Whitlock" || id.Issuer != idp.URL {
		t.Errorf("got %+v, want subject user-1 / name Dana Whitlock / issuer %s", id, idp.URL)
	}
}

func TestExchangeRejectsNonceMismatch(t *testing.T) {
	idp := newFakeIdP(t)
	// The token comes back tied to a different sign-in than the one the
	// callback claims to be answering, which is exactly the replay the nonce
	// exists to stop.
	idp.nonce = "some-other-signin"
	p := providerFor(t, idp.URL)

	_, err := p.Exchange(context.Background(), "code", "verifier", "the-nonce")
	if !errors.Is(err, ErrNonceMismatch) {
		t.Fatalf("got %v, want ErrNonceMismatch", err)
	}
}

func TestExchangeRejectsMissingIDToken(t *testing.T) {
	idp := newFakeIdP(t)
	idp.nonce = "the-nonce"
	idp.omitIDToken = true
	p := providerFor(t, idp.URL)

	_, err := p.Exchange(context.Background(), "code", "verifier", "the-nonce")
	if err == nil {
		t.Fatal("a token response without an id_token was accepted")
	}
	// The message is the only signal the operator gets, and it has to point at
	// the misconfigured scope rather than at some generic failure.
	if !strings.Contains(err.Error(), "id_token") {
		t.Errorf("got %q, want an error naming the missing id_token", err)
	}
}

func TestDiscoverFailsOnUnreachableIssuer(t *testing.T) {
	// A server that is started and immediately closed leaves an address
	// nothing is listening on, which is what an identity provider that is down
	// looks like from here.
	down := httptest.NewServer(http.NotFoundHandler())
	issuer := down.URL
	down.Close()

	p := providerFor(t, issuer)
	err := p.discover(context.Background())
	if err == nil {
		t.Fatal("an unreachable identity provider was treated as reachable")
	}
	if !strings.Contains(err.Error(), issuer) {
		t.Errorf("got %q, want a wrapped error naming the issuer %s", err, issuer)
	}
	if errors.Unwrap(err) == nil {
		t.Errorf("got %q, want an error that wraps the transport failure underneath", err)
	}
}

func TestDiscoverDoesNotCacheAFailedLookup(t *testing.T) {
	// A provider that is briefly unreachable must not poison the cache: once
	// it comes back, the next sign-in has to succeed without a restart.
	idp := newFakeIdP(t)
	var broken atomic.Bool
	broken.Store(true)

	var hits int32
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if broken.Load() {
			http.Error(w, "the identity provider is restarting", http.StatusInternalServerError)
			return
		}
		idp.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(gate.Close)

	// Discovery insists the document's issuer matches the URL it was fetched
	// from, so the fake has to answer as the gate.
	idp.Server.URL = gate.URL

	p := providerFor(t, gate.URL)
	if err := p.discover(context.Background()); err == nil {
		t.Fatal("a failing discovery was reported as a success")
	}

	before := atomic.LoadInt32(&hits)
	broken.Store(false)
	if err := p.discover(context.Background()); err != nil {
		t.Fatalf("discovery did not retry after the provider recovered: %v", err)
	}
	if atomic.LoadInt32(&hits) == before {
		t.Fatal("discover() did not actually re-contact the provider after a failed lookup — the failure may have been cached")
	}
}

func TestDiscoverDoesNotSerializeConcurrentCallers(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)

	p := providerFor(t, srv.URL)
	p.discoveryTimeout = 200 * time.Millisecond

	const waiters = 5
	start := time.Now()
	var wg sync.WaitGroup
	for range waiters {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := p.discover(context.Background()); err == nil {
				t.Error("a hanging identity provider was treated as reachable")
			}
		}()
	}
	wg.Wait()
	// Serialized, this would take waiters × the timeout; collapsed onto one
	// attempt it takes roughly one window.
	if elapsed := time.Since(start); elapsed > 2*p.discoveryTimeout {
		t.Fatalf("%d waiters took %v, want roughly one %v window", waiters, elapsed, p.discoveryTimeout)
	}
	// The wall-clock bound above would also hold if every caller raced the
	// network independently (each racing attempt still times out within one
	// window); only the hit count proves the callers actually collapsed onto
	// a single singleflight attempt.
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("identity provider was hit %d times for %d concurrent callers, want 1 (singleflight should collapse them)", got, waiters)
	}
}

func TestDiscoverSurvivesTheFirstCallerGivingUp(t *testing.T) {
	idp := newFakeIdP(t)
	release := make(chan struct{})
	requestReceived := make(chan struct{})
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(requestReceived)
		<-release
		idp.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(gate.Close)
	idp.Server.URL = gate.URL

	p := providerFor(t, gate.URL)
	impatient, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() { done <- p.discover(impatient) }()
	// Let the first caller actually reach the network before it walks away,
	// rather than guessing at a wall-clock margin.
	select {
	case <-requestReceived:
	case <-time.After(5 * time.Second):
		t.Fatal("the first caller never reached the identity provider")
	}
	cancel()
	close(release)

	if err := <-done; err != nil {
		t.Fatalf("discovery was cancelled by the caller that started it: %v", err)
	}
}

func TestDiscoveryWindowDefaultsToFifteenSeconds(t *testing.T) {
	p := &Provider{}
	if got := p.discoveryWindow(); got != 15*time.Second {
		t.Fatalf("an unset discoveryTimeout gave a %v window, want 15s — production would %s", got, "either expire immediately or never")
	}

	p.discoveryTimeout = 200 * time.Millisecond
	if got := p.discoveryWindow(); got != 200*time.Millisecond {
		t.Fatalf("an explicit discoveryTimeout gave a %v window, want 200ms", got)
	}
}

// Warm is the boot probe's entry point. It has to reuse the same singleflight
// discovery the sign-in path uses rather than opening a second one.
func TestWarmDiscoversTheProvider(t *testing.T) {
	idp := newFakeIdP(t)
	p := providerFor(t, idp.URL)
	if err := p.Warm(context.Background()); err != nil {
		t.Fatalf("Warm: %v", err)
	}
	p.mu.Lock()
	warm := p.oauth != nil
	p.mu.Unlock()
	if !warm {
		t.Fatal("Warm returned nil but left the provider cold")
	}
}

// The single most important property of the boot probe: a failed probe must
// not be cached. If it were, a diagnostic aimed at a provider that was merely
// slow to start would turn every later sign-in into the same stale failure.
func TestAFailedWarmDoesNotPoisonALaterSignIn(t *testing.T) {
	idp := newFakeIdP(t)
	unreachable := providerFor(t, "http://127.0.0.1:1")
	if err := unreachable.Warm(context.Background()); err == nil {
		t.Fatal("Warm unexpectedly succeeded against a dead issuer")
	}

	p := providerFor(t, idp.URL)
	if err := p.Warm(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Same provider, a failure followed by a success on the shared cache.
	p2 := providerFor(t, "http://127.0.0.1:1")
	if err := p2.Warm(context.Background()); err == nil {
		t.Fatal("Warm unexpectedly succeeded")
	}
	p2.cfg.Issuer = idp.URL
	if err := p2.Warm(context.Background()); err != nil {
		t.Fatalf("a failed probe poisoned the discovery cache: %v", err)
	}
}
