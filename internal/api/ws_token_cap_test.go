package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lets-parley/parley/internal/store"
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

// TestWebSocketCapIsPerTokenNotPerUser pins the key: the budget is the session
// token, not the user. One person with two devices holds two tokens and two
// budgets. Keying the count on UserID would make a second device steal the
// first's allowance — and would leave this test green if it were never written.
func TestWebSocketCapIsPerTokenNotPerUser(t *testing.T) {
	pool := testPool(t)
	handler := Router(pool, Options{
		AllowedOrigin: testOrigin,
		Context:       testContext(t),
		Limits:        Limits{WSMaxPerToken: 1},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})

	tokenA, _, id := setupSession(t, srv, "Per Token Not Per User")
	userID := userIDOf(t, srv, tokenA)

	plainB, hashB := store.NewToken()
	if _, err := pool.Exec(context.Background(),
		"insert into session_tokens (token_hash, user_id) values ($1, $2)", hashB, userID); err != nil {
		t.Fatal(err)
	}
	tokenB := &http.Cookie{Name: sessionCookie, Value: plainB}

	socketA, _, err := dialWS(t, srv, id, tokenA, testOrigin)
	if err != nil {
		t.Fatalf("first socket on token A: %v", err)
	}
	defer socketA.Close()
	if _, ok := readEnvelope(t, socketA, 5*time.Second); !ok {
		t.Fatal("token A's socket never received its initial frame")
	}

	socketB, _, err := dialWS(t, srv, id, tokenB, testOrigin)
	if err != nil {
		t.Fatalf("first socket on token B, same user: %v", err)
	}
	defer socketB.Close()
	if _, ok := readEnvelope(t, socketB, 5*time.Second); !ok {
		t.Fatal("token B's socket never received its initial frame")
	}

	over, resp, err := dialWS(t, srv, id, tokenA, testOrigin)
	if err == nil {
		over.Close()
		t.Fatal("a second socket on token A was accepted at cap 1")
	}
	if resp == nil {
		t.Fatalf("the refused dial returned no HTTP response: %v", err)
	}
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second socket on token A returned %d, want %d", resp.StatusCode, http.StatusTooManyRequests)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	// Token B's already-open socket must still see the room. Closing A
	// broadcasts; if a UserID-keyed cap had taken B down with A's refusal,
	// this read would not land.
	socketA.Close()
	if _, ok := readEnvelope(t, socketB, 5*time.Second); !ok {
		t.Fatal("token B's socket stopped receiving after token A was refused")
	}
}

// TestWebSocketCapReleasesWhenUpgradeFails pins the path where ReserveToken
// succeeds and gorilla's Upgrade then refuses the request (a plain GET, no
// Upgrade headers). Skipping the release on that error used to leave every
// test green: the next real dial would 429 until restart.
func TestWebSocketCapReleasesWhenUpgradeFails(t *testing.T) {
	pool := testPool(t)
	handler := Router(pool, Options{
		AllowedOrigin: testOrigin,
		Context:       testContext(t),
		Limits:        Limits{WSMaxPerToken: 1},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(func() {
		handler.Shutdown()
		srv.Close()
	})

	fac, _, id := setupSession(t, srv, "Upgrade Fail Releases")

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/ws?session="+id, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(fac)
	req.Header.Set("Origin", testOrigin)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("plain GET: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode == http.StatusSwitchingProtocols {
		t.Fatal("plain GET upgraded; the test never reached an Upgrade failure")
	}

	ws, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatalf("real dial after a failed upgrade: %v", err)
	}
	ws.Close()
}
