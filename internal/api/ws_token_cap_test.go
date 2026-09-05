package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestWebSocketCapPerToken pins the per-token socket bound. One authenticated
// client could otherwise hold as many sockets as it liked, each costing a
// goroutine pair, a send buffer and a revalidation query every 30s.
//
// The cap is two here and three sockets are opened, so the numbers are read
// off the test rather than computed from the code under test. The third dial
// has to be refused before the upgrade — a plain 429 a client can read — and
// the sockets already open have to survive it, which is what separates a cap
// from an outage. Closing one and dialing again is the other half: without a
// decrement on teardown the bound would tighten to nothing over a day.
func TestWebSocketCapPerToken(t *testing.T) {
	pool := testPool(t)
	handler := Router(pool, Options{
		AllowedOrigin: testOrigin,
		Context:       testContext(t),
		Limits:        Limits{WSMaxPerToken: 2},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})

	fac, _, id := setupSession(t, srv, "Socket Cap Space")

	first, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatalf("first socket: %v", err)
	}
	defer first.Close()
	if _, ok := readEnvelope(t, first, 5*time.Second); !ok {
		t.Fatalf("the first socket never received its initial frame")
	}
	second, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatalf("second socket, still inside the cap of 2: %v", err)
	}
	if _, ok := readEnvelope(t, second, 5*time.Second); !ok {
		t.Fatalf("the second socket never received its initial frame")
	}

	over, resp, err := dialWS(t, srv, id, fac, testOrigin)
	if err == nil {
		over.Close()
		t.Fatalf("the third socket on one token was accepted; the cap of 2 did nothing")
	}
	if resp == nil {
		t.Fatalf("the refused dial returned no HTTP response: %v", err)
	}
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("refused dial returned %d, want %d", resp.StatusCode, http.StatusTooManyRequests)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), "too many open connections for this session") {
		t.Fatalf("refused dial body = %q, want the lowercase JSON error", string(body))
	}

	// The refusal must cost the sockets already open nothing: the first one
	// still sees the room change when the second leaves.
	second.Close()
	if _, ok := readEnvelope(t, first, 5*time.Second); !ok {
		t.Fatalf("the first socket stopped receiving broadcasts after a peer was refused")
	}

	// And the slot the closed socket held comes back. Teardown is asynchronous,
	// so this retries rather than racing it.
	deadline := time.Now().Add(5 * time.Second)
	for {
		replacement, _, err := dialWS(t, srv, id, fac, testOrigin)
		if err == nil {
			replacement.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("a new socket was still refused after one closed; the count never decremented: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
