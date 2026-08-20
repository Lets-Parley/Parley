package api

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lets-parley/parley/internal/auth"
)

// Discovery is deferred by design, and the boot probe is a diagnostic rather
// than a gate. A broken identity provider must therefore leave readiness
// alone: the server still serves everyone already signed in, and an operator
// reading /readyz never learns about the identity provider from it.
func TestReadyzStaysGreenWhenIdentityDiscoveryFails(t *testing.T) {
	pool := testPool(t)
	// Port 1 is reserved and nothing listens there, so discovery cannot succeed.
	provider := auth.New(auth.Config{Issuer: "http://127.0.0.1:1", ClientID: "parley"})
	if err := provider.Warm(t.Context()); err == nil {
		t.Fatal("discovery unexpectedly succeeded against a dead issuer")
	}

	handler := Router(pool, Options{
		Context:       t.Context(),
		AllowedOrigin: testOrigin,
		AuthMode:      ModeOIDC,
		OIDC:          provider,
	})
	t.Cleanup(handler.Shutdown)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	waitReady(t, srv, true, 10*time.Second)
}
