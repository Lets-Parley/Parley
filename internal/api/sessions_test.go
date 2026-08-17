package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

const testOrigin = "http://example.test"

func createSession(t *testing.T, srv *httptest.Server, slug, kind, title string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/sessions",
		strings.NewReader(`{"kind":"`+kind+`","title":"`+title+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	return resp, body
}

func doJSON(t *testing.T, srv *httptest.Server, method, path, body string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	var rd *strings.Reader
	if body == "" {
		rd = strings.NewReader("")
	} else {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, srv.URL+path, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	return resp, out
}

func dialWS(t *testing.T, srv *httptest.Server, sessionID string, cookie *http.Cookie, origin string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?session=" + sessionID
	h := http.Header{}
	if cookie != nil {
		h.Set("Cookie", cookie.Name+"="+cookie.Value)
	}
	if origin != "" {
		h.Set("Origin", origin)
	}
	return websocket.DefaultDialer.Dial(url, h)
}

func readEnvelope(t *testing.T, ws *websocket.Conn, timeout time.Duration) (map[string]any, bool) {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(timeout))
	_, msg, err := ws.ReadMessage()
	if err != nil {
		return nil, false
	}
	var env map[string]any
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("bad frame: %v", err)
	}
	return env, true
}

func setupSession(t *testing.T, srv *httptest.Server, spaceName string) (facilitator, member *http.Cookie, sessionID string) {
	t.Helper()
	facilitator = signup(t, srv, "Fay")
	member = signup(t, srv, "Mel")
	_, sp := createSpace(t, srv, spaceName, facilitator)
	slug := sp["slug"].(string)
	if resp := joinSpace(t, srv, slug, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	resp, sess := createSession(t, srv, slug, "poker", "Sprint 12", facilitator)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create session: %d %v", resp.StatusCode, sess)
	}
	return facilitator, member, sess["id"].(string)
}

func testDBPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestSessionMembershipAuthz(t *testing.T) {
	srv := testServer(t)
	_, _, id := setupSession(t, srv, "Authz Space")
	outsider := signup(t, srv, "Out")

	if resp, _ := doJSON(t, srv, "GET", "/api/sessions/"+id, "", outsider); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider GET: got %d, want 404", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "GET", "/api/sessions/"+id, "", nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("anonymous GET: got %d, want 404", resp.StatusCode)
	}
	if _, resp, err := dialWS(t, srv, id, outsider, testOrigin); err == nil {
		t.Fatal("outsider WS upgrade succeeded")
	} else if resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider WS: expected 404 response, got %v", resp)
	}
}

func TestWSOriginRejected(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Origin Space")

	if _, _, err := dialWS(t, srv, id, fac, "http://evil.example"); err == nil {
		t.Fatal("cross-origin WS upgrade succeeded")
	}
	ws, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatalf("allowed-origin WS failed: %v", err)
	}
	ws.Close()
}

func TestCrossSitePostRejected(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")

	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://evil.example")
	req.AddCookie(ada)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-site POST: got %d, want 403", resp.StatusCode)
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" ||
		resp.Header.Get("Content-Security-Policy") == "" {
		t.Fatal("security headers missing")
	}
}

func TestFacilitatorRules(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Facilitator Space")

	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id, "", member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member close: got %d, want 403", resp.StatusCode)
	}

	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("facilitator close: got %d", resp.StatusCode)
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["endedAt"] == nil {
		t.Fatal("close did not set endedAt")
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/reopen", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reopen: got %d", resp.StatusCode)
	}
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["endedAt"] != nil {
		t.Fatal("reopen did not clear endedAt")
	}

	// Transfer to a non-member fails; to a member succeeds.
	outsider := signup(t, srv, "Out")
	_, out := doJSON(t, srv, "GET", "/api/me", "", outsider)
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator",
		`{"userId":"`+out["id"].(string)+`"}`, fac); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("transfer to outsider: got %d, want 400", resp.StatusCode)
	}
	_, mel := doJSON(t, srv, "GET", "/api/me", "", member)
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator",
		`{"userId":"`+mel["id"].(string)+`"}`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("transfer to member: got %d", resp.StatusCode)
	}
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", member)
	if env["facilitatorId"] != mel["id"] {
		t.Fatalf("transfer did not take: %v", env["facilitatorId"])
	}
}

func TestFacilitatorClaim(t *testing.T) {
	srv := testServer(t)
	_, member, id := setupSession(t, srv, "Claim Space")

	// Inside the grace period: rejected.
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator/claim", "", member); resp.StatusCode != http.StatusConflict {
		t.Fatalf("early claim: got %d, want 409", resp.StatusCode)
	}

	pool := testDBPool(t)
	if _, err := pool.Exec(context.Background(),
		"update sessions set facilitator_seen_at = now() - interval '2 minutes' where id = $1", id); err != nil {
		t.Fatal(err)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator/claim", "", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("claim after grace: got %d", resp.StatusCode)
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", member)
	_, mel := doJSON(t, srv, "GET", "/api/me", "", member)
	if env["facilitatorId"] != mel["id"] {
		t.Fatal("claim did not transfer the role")
	}
}

func TestConcurrentClaimsHaveOneWinner(t *testing.T) {
	srv := testServer(t)
	fac, m1, id := setupSession(t, srv, "Race Space")
	_ = fac
	m2 := signup(t, srv, "Second")
	if resp := joinSpace(t, srv, "race-space", m2); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}

	pool := testDBPool(t)
	if _, err := pool.Exec(context.Background(),
		"update sessions set facilitator_seen_at = now() - interval '2 minutes' where id = $1", id); err != nil {
		t.Fatal(err)
	}

	codes := make([]int, 2)
	var wg sync.WaitGroup
	for i, c := range []*http.Cookie{m1, m2} {
		wg.Add(1)
		go func(i int, c *http.Cookie) {
			defer wg.Done()
			req, _ := http.NewRequest("POST", srv.URL+"/api/sessions/"+id+"/facilitator/claim", strings.NewReader(""))
			req.AddCookie(c)
			resp, err := srv.Client().Do(req)
			if err == nil {
				codes[i] = resp.StatusCode
				resp.Body.Close()
			}
		}(i, c)
	}
	wg.Wait()

	wins := 0
	for _, code := range codes {
		if code == http.StatusNoContent {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("expected exactly one winning claim, got codes %v", codes)
	}
}

func TestBroadcastReachesAllClients(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Broadcast Space")

	wsA, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsA.Close()
	wsB, _, err := dialWS(t, srv, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsB.Close()

	// Both get an initial frame.
	envA, ok := readEnvelope(t, wsA, 3*time.Second)
	if !ok {
		t.Fatal("no initial frame on A")
	}
	if _, ok := readEnvelope(t, wsB, 3*time.Second); !ok {
		t.Fatal("no initial frame on B")
	}
	baseVersion := envA["version"].(float64)

	// A REST mutation must reach both clients with a bumped version.
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("close: %d", resp.StatusCode)
	}
	deadline := time.Now().Add(5 * time.Second)
	for _, ws := range []*websocket.Conn{wsA, wsB} {
		got := false
		for time.Now().Before(deadline) {
			env, ok := readEnvelope(t, ws, time.Until(deadline))
			if !ok {
				break
			}
			if env["endedAt"] != nil && env["version"].(float64) > baseVersion {
				got = true
				break
			}
		}
		if !got {
			t.Fatal("client did not receive the mutation broadcast")
		}
	}
}

func TestPresenceUpdatesOnConnect(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Presence Space")
	_, mel := doJSON(t, srv, "GET", "/api/me", "", member)

	wsA, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsA.Close()
	if _, ok := readEnvelope(t, wsA, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}

	wsB, _, err := dialWS(t, srv, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsB.Close()

	// Within a couple of seconds A must see B in presence.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		env, ok := readEnvelope(t, wsA, time.Until(deadline))
		if !ok {
			break
		}
		for _, u := range env["presence"].([]any) {
			if u == mel["id"] {
				return
			}
		}
	}
	t.Fatal("presence never included the second user")
}

func TestStalledClientDoesNotFreezeRoom(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Stall Space")

	// Stalled client: connects and never reads.
	wsStall, _, err := dialWS(t, srv, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsStall.Close()

	wsLive, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsLive.Close()
	if _, ok := readEnvelope(t, wsLive, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}

	// Overflow the stalled client's 16-slot buffer.
	for i := 0; i < 40; i++ {
		verb := "DELETE"
		path := "/api/sessions/" + id
		if i%2 == 1 {
			verb, path = "POST", "/api/sessions/"+id+"/reopen"
		}
		if resp, _ := doJSON(t, srv, verb, path, "", fac); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("mutation %d: %d", i, resp.StatusCode)
		}
	}

	// The live client must still be receiving fresh frames.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		env, ok := readEnvelope(t, wsLive, time.Until(deadline))
		if !ok {
			t.Fatal("live client stopped receiving")
		}
		if env["version"].(float64) >= 40 {
			return
		}
	}
	t.Fatal("live client never saw the final state")
}

func TestSessionKindValidation(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Kind Space", ada)
	slug := sp["slug"].(string)

	if resp, _ := createSession(t, srv, slug, "retro", "Nope", ada); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown kind: got %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/sessions",
		strings.NewReader(`{"kind":"poker","title":"T","config":{"bogus":1}}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(ada)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown config field: got %d, want 400", resp.StatusCode)
	}
}
