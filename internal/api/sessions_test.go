package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/dbtest"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
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

func readWSCloseCode(t *testing.T, ws *websocket.Conn, timeout time.Duration) int {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(timeout))
	for {
		if _, _, err := ws.ReadMessage(); err != nil {
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) {
				return closeErr.Code
			}
			t.Fatalf("read websocket close: %v", err)
		}
	}
}

func setupSession(t *testing.T, srv *httptest.Server, spaceName string) (facilitator, member *http.Cookie, sessionID string) {
	t.Helper()
	facilitator = signup(t, srv, "Fay")
	member = signup(t, srv, "Mel")
	_, sp := createSpace(t, srv, spaceName, facilitator)
	slug := sp["slug"].(string)
	code, _ := sp["passcode"].(string)
	if resp := joinSpace(t, srv, slug, member, code); resp.StatusCode != http.StatusNoContent {
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
	pool, err := pgxpool.New(context.Background(), dbtest.DSN(t))
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

func TestHandlerShutdownClosesHubSockets(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), "postgres://unused:unused@127.0.0.1/unused")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	handler := Router(pool, Options{AllowedOrigin: testOrigin})
	handler.hub.OnFacilitatorSeen = nil
	handler.hub.OnPresenceChange = nil

	attached := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		handler.hub.Attach(ws, "room", "user", nil)
		close(attached)
	}))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	select {
	case <-attached:
	case <-time.After(time.Second):
		t.Fatal("server did not attach websocket")
	}

	handler.Shutdown()

	if code := readWSCloseCode(t, ws, time.Second); code != websocket.CloseGoingAway {
		t.Fatalf("handler shutdown websocket close code = %d, want %d", code, websocket.CloseGoingAway)
	}
	select {
	case <-handler.hub.Done():
	default:
		t.Fatal("handler shutdown left the hub owner running")
	}
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
	_, race := doJSON(t, srv, "GET", "/api/spaces/race-space", "", m1)
	raceCode, _ := race["passcode"].(string)
	if resp := joinSpace(t, srv, "race-space", m2, raceCode); resp.StatusCode != http.StatusNoContent {
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

func TestLogoutClosesWebSocketAuthenticatedByToken(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Logout Socket Space")

	ws, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}

	if resp, _ := doJSON(t, srv, "DELETE", "/api/me", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: got %d, want 204", resp.StatusCode)
	}
	if code := readWSCloseCode(t, ws, 2*time.Second); code != websocket.ClosePolicyViolation {
		t.Fatalf("logout websocket close code = %d, want %d", code, websocket.ClosePolicyViolation)
	}
}

func TestWSRevalidatesTokenAgainstDatabase(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin:               testOrigin,
		sessionRevalidationInterval: 20 * time.Millisecond,
	})
	fac, _, id := setupSession(t, srv, "Replica Revocation Space")

	ws, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}

	hash, err := store.HashToken(fac.Value)
	if err != nil {
		t.Fatal(err)
	}
	pool := testDBPool(t)
	if _, err := pool.Exec(context.Background(), "delete from session_tokens where token_hash = $1", hash); err != nil {
		t.Fatal(err)
	}

	if code := readWSCloseCode(t, ws, 2*time.Second); code != websocket.ClosePolicyViolation {
		t.Fatalf("database-revoked websocket close code = %d, want %d", code, websocket.ClosePolicyViolation)
	}
}

func TestWSRejectsRevokedTokenAtHandshake(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Revoked Handshake Space")
	hash, err := store.HashToken(fac.Value)
	if err != nil {
		t.Fatal(err)
	}
	pool := testDBPool(t)
	if _, err := pool.Exec(context.Background(), "delete from session_tokens where token_hash = $1", hash); err != nil {
		t.Fatal(err)
	}

	if _, resp, err := dialWS(t, srv, id, fac, testOrigin); err == nil {
		t.Fatal("revoked token websocket upgrade succeeded")
	} else if resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("revoked token websocket response = %v, want 404", resp)
	}
}

func TestWSClosesWhenTokenExpiresInDatabase(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin:               testOrigin,
		sessionRevalidationInterval: 20 * time.Millisecond,
	})
	fac, _, id := setupSession(t, srv, "Expired Socket Space")

	ws, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}

	hash, err := store.HashToken(fac.Value)
	if err != nil {
		t.Fatal(err)
	}
	pool := testDBPool(t)
	if _, err := pool.Exec(context.Background(), `
		update session_tokens set last_used_at = now() - interval '91 days'
		where token_hash = $1`, hash); err != nil {
		t.Fatal(err)
	}

	if code := readWSCloseCode(t, ws, 2*time.Second); code != websocket.ClosePolicyViolation {
		t.Fatalf("expired websocket close code = %d, want %d", code, websocket.ClosePolicyViolation)
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

func TestTransferToSelfIsANoOp(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Self Transfer Space")
	_, fay := doJSON(t, srv, "GET", "/api/me", "", fac)

	ws, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 5*time.Second); !ok {
		t.Fatal("no initial state frame")
	}

	_, before := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	beforeVersion, ok := before["version"].(float64)
	if !ok {
		t.Fatalf("session envelope missing version: %v", before)
	}

	resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator",
		`{"userId":"`+fay["id"].(string)+`"}`, fac)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("transfer to self: got %d %v, want 204", resp.StatusCode, body)
	}

	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["facilitatorId"] != fay["id"] {
		t.Fatalf("self transfer dropped the role: facilitatorId = %v, want %v", env["facilitatorId"], fay["id"])
	}
	afterVersion, ok := env["version"].(float64)
	if !ok {
		t.Fatalf("session envelope missing version: %v", env)
	}
	if afterVersion != beforeVersion {
		t.Fatalf("self transfer wrote to the session: version = %v, want %v", afterVersion, beforeVersion)
	}
	if frame, ok := readEnvelope(t, ws, time.Second); ok {
		t.Fatalf("self transfer broadcast a state frame: %v", frame)
	}
}

func TestTransferToNonMemberIsRejected(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Stranger Space")

	// A user who belongs to some other space entirely.
	stranger := signup(t, srv, "Stan")
	createSpace(t, srv, "Somewhere Else", stranger)
	_, stan := doJSON(t, srv, "GET", "/api/me", "", stranger)

	resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator",
		`{"userId":"`+stan["id"].(string)+`"}`, fac)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("transfer to non-member: got %d, want 400", resp.StatusCode)
	}
	if body["error"] != "that person is not a member of this space" {
		t.Fatalf("transfer to non-member error = %v", body["error"])
	}

	_, fay := doJSON(t, srv, "GET", "/api/me", "", fac)
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["facilitatorId"] != fay["id"] {
		t.Fatalf("rejected transfer still moved the role: %v", env["facilitatorId"])
	}
}

func TestTransferRequiresUserId(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Missing Id Space")

	for _, body := range []string{`{}`, `{"userId":""}`} {
		resp, out := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator", body, fac)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("transfer with %s: got %d, want 400", body, resp.StatusCode)
		}
		if out["error"] != "userId is required" {
			t.Fatalf("transfer with %s: error = %v", body, out["error"])
		}
	}
}

func TestTransferBroadcastsNewFacilitator(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Transfer Broadcast Space")
	_, mel := doJSON(t, srv, "GET", "/api/me", "", member)

	ws, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.Close() })
	if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator",
		`{"userId":"`+mel["id"].(string)+`"}`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("transfer: got %d", resp.StatusCode)
	}

	// The handler's own broadcast must be the very next frame delivered:
	// once the POST has returned, nothing else should still be in flight
	// within this tight window unless the handler broadcast it itself.
	env, ok := readEnvelope(t, ws, 500*time.Millisecond)
	if !ok {
		t.Fatal("no broadcast immediately following the transfer response")
	}
	if env["facilitatorId"] != mel["id"] {
		t.Fatalf("broadcast after transfer named facilitatorId = %v, want %v", env["facilitatorId"], mel["id"])
	}
}

// A kind retired in place is still a registered kind and still a valid foreign
// key, so nothing but an explicit check stops a new session from using it.
func TestSessionCreationRejectsARetiredKind(t *testing.T) {
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Retired Space", ada)
	slug := sp["slug"].(string)

	retireKind(t, pool, "standup")

	resp, body := createSession(t, srv, slug, "standup", "Nope", ada)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("creating a session of a retired kind: got %d, want 400 (%v)", resp.StatusCode, body)
	}
	// The specific refusal, not merely a 400: every other rejection on this
	// path (unknown kind, missing seed row, bad config) also answers 400.
	if msg, _ := body["error"].(string); msg != "that session kind has been retired" {
		t.Fatalf("refusal message = %q, want the retired-kind message", msg)
	}
	// A kind that was never retired still works.
	if resp, _ := createSession(t, srv, slug, "poker", "Sprint 1", ada); resp.StatusCode != http.StatusCreated {
		t.Fatalf("creating a session of a live kind: got %d", resp.StatusCode)
	}
}

// Creating a session with a kind the server has never registered has to name
// the kinds that are actually available, not just the built-ins, so the
// handler's wiring of unknownKindMessage is exercised here rather than only
// the helper in isolation.
func TestSessionCreationRejectsAnUnknownKindWithTheRegisteredList(t *testing.T) {
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Space", ada)
	slug := sp["slug"].(string)

	resp, body := createSession(t, srv, slug, "bogus-kind", "Title", ada)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("creating a session of an unknown kind: got %d, want 400 (%v)", resp.StatusCode, body)
	}
	msg, _ := body["error"].(string)
	if msg != "kind must be one of poker, standup" {
		t.Fatalf("error %q does not name exactly the registered kinds", msg)
	}
}

// The unknown-kind message has to stay true for whatever set of kinds is
// registered, so it is derived from the registry rather than hardcoded. This
// one needs no database: it exercises the message, not the handler. The exact
// (sorted) comparison also pins the ordering, so removing the registry's sort
// fails this test rather than only being caught by chance.
func TestUnknownKindMessageNamesEveryRegisteredKind(t *testing.T) {
	kinds := session.NewRegistry()
	for _, name := range []string{"poker", "standup", "retro"} {
		if err := kinds.Register(session.Kind{Name: name}); err != nil {
			t.Fatal(err)
		}
	}
	msg := unknownKindMessage(kinds)
	if msg != "kind must be one of poker, retro, standup" {
		t.Fatalf("unknown-kind message %q is not in sorted order", msg)
	}
	if !strings.Contains(msg, "retro") {
		t.Fatalf("unknown-kind message %q does not name the third registered kind", msg)
	}
	if msg != strings.ToLower(msg) {
		t.Fatalf("unknown-kind message %q is not lowercase", msg)
	}
}

// A kind registered in Go but never seeded into session_kinds trips the
// foreign key at the insert. That is the contributor mistake the add-a-kind
// checklist exists to catch, so it has to read as a 4xx naming the missing
// row rather than a generic 500.
func TestSessionCreationReportsAMissingSeedRow(t *testing.T) {
	pool := testPool(t)
	srv := httptest.NewServer(Router(pool, Options{AllowedOrigin: testOrigin}))
	t.Cleanup(srv.Close)

	ada := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Unseeded Space", ada)
	slug := sp["slug"].(string)

	// standup stays registered in Go; only its seed row goes away.
	if _, err := pool.Exec(context.Background(),
		"delete from session_kinds where kind = 'standup'"); err != nil {
		t.Fatal(err)
	}

	resp, body := createSession(t, srv, slug, "standup", "Unseeded", ada)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("creating a session of an unseeded kind: got %d, want 400 (%v)", resp.StatusCode, body)
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "session_kinds") {
		t.Fatalf("error %q does not name the missing session_kinds row", msg)
	}
}

// retireKind sets retired_at on a seeded kind and restores it when the test
// ends. The test database is shared by every test in the package, so a kind
// left retired would silently change what later tests are allowed to create.
func retireKind(t *testing.T, pool *pgxpool.Pool, kind string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		"update session_kinds set retired_at = now() where kind = $1", kind); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			"update session_kinds set retired_at = null where kind = $1", kind); err != nil {
			t.Errorf("restoring the retired kind: %v", err)
		}
	})
}
