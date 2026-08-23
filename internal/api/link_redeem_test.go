package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lets-parley/parley/internal/store"
)

// redeem posts a token to the redemption door and hands back the response, its
// body and the session cookie it set (nil when it set none).
func redeem(t *testing.T, srv *httptest.Server, token, name string) (*http.Response, map[string]any, *http.Cookie) {
	t.Helper()
	body, err := json.Marshal(map[string]string{"token": token, "name": name})
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/links/redeem", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			cookie = c
		}
	}
	return resp, out, cookie
}

// mintAndRedeem is the whole happy path in one line: a facilitator's room, a
// link minted for it, and a guest holding the cookie it bought.
func mintAndRedeem(t *testing.T, srv *httptest.Server, spaceName string) (fac *http.Cookie, sessionID string, guest *http.Cookie) {
	t.Helper()
	fac, _, sessionID = setupSession(t, srv, spaceName)
	_, minted := mintLink(t, srv, sessionID, fac)
	token, _ := minted["token"].(string)
	if token == "" {
		t.Fatalf("mint returned no token: %v", minted)
	}
	resp, body, guest := redeem(t, srv, token, "Gus")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("redeem: got %d, want 201 (%v)", resp.StatusCode, body)
	}
	if body["sessionId"] != sessionID {
		t.Fatalf("redeem sessionId = %v, want %s", body["sessionId"], sessionID)
	}
	if guest == nil {
		t.Fatal("redeem set no session cookie")
	}
	return fac, sessionID, guest
}

func TestRedeemLinkGrantsParticipateOnTheBoundRoom(t *testing.T) {
	srv := testServer(t)
	fac, id, guest := mintAndRedeem(t, srv, "Redeem Space")

	if resp, body := doJSON(t, srv, "GET", "/api/sessions/"+id, "", guest); resp.StatusCode != http.StatusOK {
		t.Fatalf("guest read the bound room: got %d, want 200 (%v)", resp.StatusCode, body)
	}
	// A participate action is the whole capability: the guest votes like
	// anybody else in the room.
	story := addStory(t, srv, id, "Story", fac)
	selectStory(t, srv, id, story, fac)
	if resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/vote",
		`{"storyId":"`+story+`","value":"5"}`, guest); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("guest vote: got %d, want 204 (%v)", resp.StatusCode, body)
	}
	// Facilitator-only actions stay shut, by the dispatcher's existing flag.
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", guest); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("guest reveal: got %d, want 403", resp.StatusCode)
	}
	// The redemption is counted, and the count is all the list ever shows.
	_, list := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", fac)
	entry := list["links"].([]any)[0].(map[string]any)
	if entry["redemptions"].(float64) != 1 {
		t.Fatalf("redemptions = %v, want 1", entry["redemptions"])
	}
}

func TestRedeemLinkNeverEchoesTheSubmittedToken(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Echo Space")
	_, minted := mintLink(t, srv, id, fac)
	live := minted["token"].(string)

	bogus, _ := store.NewToken()
	for _, token := range []string{bogus, "not-even-base64!!", strings.Repeat("a", 64)} {
		resp, body, cookie := redeem(t, srv, token, "Mallory")
		if resp.StatusCode < 400 || resp.StatusCode >= 500 {
			t.Fatalf("redeem %q: got %d, want a 4xx", token, resp.StatusCode)
		}
		if cookie != nil {
			t.Fatalf("redeem %q set a session cookie", token)
		}
		blob, _ := json.Marshal(body)
		if strings.Contains(string(blob), token) {
			t.Fatalf("4xx body echoed the submitted token: %s", blob)
		}
	}
	// And a revoked link is refused the same way as one that never existed.
	linkID := minted["id"].(string)
	doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", fac)
	if resp, _, _ := redeem(t, srv, live, "Mallory"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("revoked link redeem: got %d, want 404", resp.StatusCode)
	}
}

func TestRedeemLinkThrottlesWrongTokens(t *testing.T) {
	srv := testServer(t)
	var got int
	for i := 0; i < passcodeAttemptLimit+1; i++ {
		bogus, _ := store.NewToken()
		resp, _, _ := redeem(t, srv, bogus, "Mallory")
		got = resp.StatusCode
	}
	if got != http.StatusTooManyRequests {
		t.Fatalf("after %d wrong tokens: got %d, want 429", passcodeAttemptLimit+1, got)
	}
}

func TestRedeemLinkIsChargedAgainstTheIdentityLimit(t *testing.T) {
	// setupSession signs up two identities, so a cap of three leaves room for
	// exactly one redemption.
	srv, _ := quotaServer(t, Limits{IdentityIPHourly: 3})
	fac, _, id := setupSession(t, srv, "Identity Limit Space")
	_, minted := mintLink(t, srv, id, fac)
	token := minted["token"].(string)

	if resp, body, _ := redeem(t, srv, token, "First"); resp.StatusCode != http.StatusCreated {
		t.Fatalf("first redeem: got %d, want 201 (%v)", resp.StatusCode, body)
	}
	resp, _, cookie := redeem(t, srv, token, "Second")
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second redeem: got %d, want 429", resp.StatusCode)
	}
	if cookie != nil {
		t.Fatal("rate-limited redemption still minted an identity")
	}
}

func TestRedeemLinkHonoursTheRedemptionCap(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Cap Space")
	_, minted := mintLink(t, srv, id, fac)
	token := minted["token"].(string)
	linkID := minted["id"].(string)

	pool := testDBPool(t)
	if _, err := pool.Exec(context.Background(),
		"update session_links set redemptions = $2 where id = $1", linkID, store.LinkRedemptionCap); err != nil {
		t.Fatal(err)
	}
	if resp, _, _ := redeem(t, srv, token, "One Too Many"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("redeem past the cap: got %d, want 404", resp.StatusCode)
	}
}

func TestRedeemLinkResolvesInOIDCMode(t *testing.T) {
	// The link is minted on an open-mode server and redeemed against an
	// OIDC-mode one over the same database: exactly the instance that turned
	// sign-in on, where federatedOnly would otherwise make links dead.
	pool := testPool(t)
	open := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, _, id := setupSession(t, open, "Federated Space")
	_, minted := mintLink(t, open, id, fac)
	token := minted["token"].(string)

	federated := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, AuthMode: ModeOIDC})
	resp, body, guest := redeem(t, federated, token, "Gus")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("oidc redeem: got %d, want 201 (%v)", resp.StatusCode, body)
	}
	if r, b := doJSON(t, federated, "GET", "/api/sessions/"+id, "", guest); r.StatusCode != http.StatusOK {
		t.Fatalf("oidc guest read the bound room: got %d, want 200 (%v)", r.StatusCode, b)
	}
}

func TestLinkGuestCannotClaimFacilitator(t *testing.T) {
	srv := testServer(t)
	_, id, guest := mintAndRedeem(t, srv, "Claim Space")
	// Age the facilitator out of the grace window so nothing but the guard
	// stands between the guest and the room.
	pool := testDBPool(t)
	if _, err := pool.Exec(context.Background(),
		"update sessions set facilitator_seen_at = now() - interval '1 day' where id = $1", id); err != nil {
		t.Fatal(err)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator/claim", "", guest); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("guest claim: got %d, want 403", resp.StatusCode)
	}
}

func TestLinkGuestCannotExportCSV(t *testing.T) {
	srv := testServer(t)
	_, id, guest := mintAndRedeem(t, srv, "Export Space")
	if resp, _ := doJSON(t, srv, "GET", "/api/sessions/"+id+"/export.csv", "", guest); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("guest export: got %d, want 403", resp.StatusCode)
	}
}

func TestLinkGuestCannotRenameItself(t *testing.T) {
	srv := testServer(t)
	_, _, guest := mintAndRedeem(t, srv, "Rename Space")
	if resp, _ := doJSON(t, srv, "POST", "/api/me", `{"name":"Facilitator"}`, guest); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("guest rename: got %d, want 403", resp.StatusCode)
	}
}

func TestLinkExpirySeversTheWebSocket(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin:               testOrigin,
		sessionRevalidationInterval: 20 * time.Millisecond,
	})
	_, id, guest := mintAndRedeem(t, srv, "Expiry Socket Space")

	ws, _, err := dialWS(t, srv, id, guest, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}
	// The link's expiry lives on the minted token, so moving it into the past
	// is the whole of mid-session severance — no sweeper, no second timer.
	hash, err := store.HashToken(guest.Value)
	if err != nil {
		t.Fatal(err)
	}
	pool := testDBPool(t)
	if _, err := pool.Exec(context.Background(),
		"update session_tokens set expires_at = now() - interval '1 minute' where token_hash = $1", hash); err != nil {
		t.Fatal(err)
	}
	if code := readWSCloseCode(t, ws, 3*time.Second); code != websocket.ClosePolicyViolation {
		t.Fatalf("expired-link websocket close code = %d, want %d", code, websocket.ClosePolicyViolation)
	}
	if resp, _ := doJSON(t, srv, "GET", "/api/sessions/"+id, "", guest); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expired-link read: got %d, want 404", resp.StatusCode)
	}
}

func TestRevokingALinkSeversTheWebSocket(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin:               testOrigin,
		sessionRevalidationInterval: 20 * time.Millisecond,
	})
	fac, id, guest := mintAndRedeem(t, srv, "Revoke Socket Space")

	ws, _, err := dialWS(t, srv, id, guest, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}
	_, list := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", fac)
	linkID := list["links"].([]any)[0].(map[string]any)["id"].(string)
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: got %d, want 204", resp.StatusCode)
	}
	if code := readWSCloseCode(t, ws, 3*time.Second); code != websocket.ClosePolicyViolation {
		t.Fatalf("revoked-link websocket close code = %d, want %d", code, websocket.ClosePolicyViolation)
	}
}

// The membership revalidator closes any socket whose holder is not in the
// space. A link guest is by design not a member, so without the hook knowing
// about links they would be dropped on a timer.
func TestLinkGuestSurvivesTheMembershipRevalidator(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{
		AllowedOrigin:               testOrigin,
		sessionRevalidationInterval: 20 * time.Millisecond,
	})
	_, id, guest := mintAndRedeem(t, srv, "Revalidator Space")

	ws, _, err := dialWS(t, srv, id, guest, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}
	// Several revalidation ticks with nothing to read but silence.
	ws.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	for {
		if _, _, err := ws.ReadMessage(); err != nil {
			if websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
				t.Fatal("the revalidator evicted a link guest")
			}
			break
		}
	}
}
