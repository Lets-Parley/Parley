package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
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

	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

	broken.Store(false)
	if err := p.discover(context.Background()); err != nil {
		t.Fatalf("discovery did not retry after the provider recovered: %v", err)
	}
}
