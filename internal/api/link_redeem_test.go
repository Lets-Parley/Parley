package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
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
	// Redemption spends its own per-address budget, not the open-signup one
	// setupSession's two identities come out of: a cap of one leaves room for
	// exactly one redemption.
	srv, _ := quotaServer(t, Limits{LinkRedemptionIPHourly: 1})
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

// TestLinkGuestCannotReachAnUnboundRoom pins the binding itself: a link names
// one room, and every other room answers a link guest exactly as it answers a
// stranger. The route table only ever walks the bound room, so without this the
// binding check could be deleted and the suite would stay green.
func TestLinkGuestCannotReachAnUnboundRoom(t *testing.T) {
	srv := testServer(t)
	_, _, guest := mintAndRedeem(t, srv, "Bound Space")
	otherFac, _, otherID := setupSession(t, srv, "Other Space")

	if resp, body := doJSON(t, srv, "GET", "/api/sessions/"+otherID, "", guest); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("guest read of an unbound room: got %d, want 404 (%v)", resp.StatusCode, body)
	}
	// Participating is the other route a link guest gets a 2xx on, so it needs
	// the same answer: a real story is selected first so that a refusal cannot
	// be mistaken for "there was nothing to vote on".
	story := addStory(t, srv, otherID, "Story", otherFac)
	selectStory(t, srv, otherID, story, otherFac)
	if resp, body := doJSON(t, srv, "POST", "/api/sessions/"+otherID+"/actions/vote",
		`{"storyId":"`+story+`","value":"5"}`, guest); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("guest vote in an unbound room: got %d, want 404 (%v)", resp.StatusCode, body)
	}
}

// TestLinkGuestCannotOpenASocketToAnUnboundRoom is the same property on the
// handshake, which carries the room in a query parameter rather than the path
// and so has its own copy of the check.
func TestLinkGuestCannotOpenASocketToAnUnboundRoom(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{AllowedOrigin: testOrigin})
	_, _, guest := mintAndRedeem(t, srv, "Bound Socket Space")
	_, _, otherID := setupSession(t, srv, "Other Socket Space")

	ws, resp, err := dialWS(t, srv, otherID, guest, testOrigin)
	if err == nil {
		ws.Close()
		t.Fatal("link guest opened a socket to an unbound room")
	}
	if resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unbound-room dial = %v (resp %v), want a 404 handshake refusal", err, resp)
	}
}

// TestRedeemedTokenExpiresWithTheLink pins the value the whole severance design
// rests on. There is no sweeper and no second timer: the guest's token is given
// the link's own expiry at redemption, and that is the only reason an expired
// link takes its guest offline mid-session. Hand the token the ordinary idle
// window instead and nothing else in the suite notices.
func TestRedeemedTokenExpiresWithTheLink(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Token Expiry Space")
	_, minted := mintLink(t, srv, id, fac)
	token, _ := minted["token"].(string)
	resp, body, guest := redeem(t, srv, token, "Gus")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("redeem: got %d, want 201 (%v)", resp.StatusCode, body)
	}

	linkExpiry, err := time.Parse(time.RFC3339Nano, body["expiresAt"].(string))
	if err != nil {
		t.Fatal(err)
	}
	hash, err := store.HashToken(guest.Value)
	if err != nil {
		t.Fatal(err)
	}
	var tokenExpiry time.Time
	if err := testDBPool(t).QueryRow(context.Background(),
		"select expires_at from session_tokens where token_hash = $1", hash).Scan(&tokenExpiry); err != nil {
		t.Fatal(err)
	}
	if drift := tokenExpiry.Sub(linkExpiry); drift > time.Second || drift < -time.Second {
		t.Fatalf("token expires_at = %s, want the link's %s (drift %s)", tokenExpiry, linkExpiry, drift)
	}

	// And the cookie is cut to the same cloth, so the browser forgets it when
	// the link dies rather than carrying a stale credential for three months.
	if want := int(store.LinkLifetime.Seconds()); guest.MaxAge > want || guest.MaxAge < want-60 {
		t.Fatalf("cookie MaxAge = %d, want roughly the link lifetime %d", guest.MaxAge, want)
	}
}

// mintAndRedeemIn is mintAndRedeem with the space slug kept, so a test can
// delete the room or the space out from under the guest.
func mintAndRedeemIn(t *testing.T, srv *httptest.Server, spaceName string) (fac *http.Cookie, slug, sessionID string, guest *http.Cookie) {
	t.Helper()
	fac = signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, spaceName, fac)
	slug = sp["slug"].(string)
	resp, sess := createSession(t, srv, slug, "poker", "Sprint 12", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create session: %d %v", resp.StatusCode, sess)
	}
	sessionID = sess["id"].(string)
	_, minted := mintLink(t, srv, sessionID, fac)
	token, _ := minted["token"].(string)
	if token == "" {
		t.Fatalf("mint returned no token: %v", minted)
	}
	r, body, guest := redeem(t, srv, token, "Gus")
	if r.StatusCode != http.StatusCreated || guest == nil {
		t.Fatalf("redeem: got %d (%v)", r.StatusCode, body)
	}
	return fac, slug, sessionID, guest
}

// Deleting the room — or the whole space — cascade-deletes the links it
// carried. The guest's identity must die with them: without that its
// users.link_id goes null while its token row survives, the principal stops
// reading as a link guest, and the routes that turn a link guest away start
// letting it through. Renaming itself there would mint a fresh token with no
// absolute expiry, turning a 24-hour participate-only guest into an ordinary
// unbounded account.
func TestDeletingTheRoomDoesNotPromoteALinkGuest(t *testing.T) {
	for _, tc := range []struct {
		name string
		path func(slug, id string) string
	}{
		{"room", func(slug, id string) string { return "/api/spaces/" + slug + "/sessions/" + id }},
		{"space", func(slug, id string) string { return "/api/spaces/" + slug }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := testServer(t)
			fac, slug, id, guest := mintAndRedeemIn(t, srv, "Cascade "+tc.name)

			if resp, body := doJSON(t, srv, "DELETE", tc.path(slug, id), "", fac); resp.StatusCode >= 300 {
				t.Fatalf("delete %s: got %d (%v)", tc.name, resp.StatusCode, body)
			}

			// The identity must simply stop working, exactly as it would if
			// the link had been revoked.
			if resp, body := doJSON(t, srv, "GET", "/api/me", "", guest); resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("GET /api/me after %s delete: got %d, want 401 (%v)", tc.name, resp.StatusCode, body)
			}
			if resp, body := doJSON(t, srv, "POST", "/api/me", `{"name":"Facilitator"}`, guest); resp.StatusCode == http.StatusOK {
				t.Fatalf("POST /api/me renamed the guest after the %s was deleted (%v)", tc.name, body)
			}
			if resp, _ := doJSON(t, srv, "GET", "/api/spaces", "", guest); resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("GET /api/spaces after %s delete: got %d, want 401", tc.name, resp.StatusCode)
			}
		})
	}
}

// TestLinkGuestEnvelopeHidesTheSpace pins both shapes of the same room's
// envelope. A link is a capability for one meeting, so the guest's copy carries
// neither the space's join slug nor a space member who is not taking part —
// otherwise one meeting link enumerates the whole space. The member's copy is
// the unredacted one, which is what makes the guest's a redaction rather than a
// change of shape for everybody.
func TestLinkGuestEnvelopeHidesTheSpace(t *testing.T) {
	srv := testServer(t)
	fac, id, guest := mintAndRedeem(t, srv, "Envelope Space")

	names := func(env map[string]any) []string {
		out := []string{}
		for _, p := range env["participants"].([]any) {
			out = append(out, p.(map[string]any)["name"].(string))
		}
		sort.Strings(out)
		return out
	}

	_, guestEnv := doJSON(t, srv, "GET", "/api/sessions/"+id, "", guest)
	if slug, _ := guestEnv["spaceSlug"].(string); slug != "" {
		t.Fatalf("guest envelope spaceSlug = %q, want empty", slug)
	}
	// Mel is a member of the space and is nowhere near this meeting, so the
	// guest never sees her. The guest holds no socket here and so has no
	// presence row, but a guest is always shown its own seat —
	// TestLinkGuestSeesItsOwnSeatWithNoSocket pins that on its own.
	if got := names(guestEnv); !slices.Equal(got, []string{"Fay", "Gus"}) {
		t.Fatalf("guest participants = %v, want the facilitator and its own seat [Fay Gus]", got)
	}

	_, facEnv := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if slug, _ := facEnv["spaceSlug"].(string); slug == "" {
		t.Fatal("member envelope lost its spaceSlug")
	}
	// The member's copy carries the whole space roster and the guest's own
	// seat: a link guest is a participant in this room, not a hidden voter.
	if got := names(facEnv); !slices.Equal(got, []string{"Fay", "Gus", "Mel"}) {
		t.Fatalf("member participants = %v, want the whole roster and the guest [Fay Gus Mel]", got)
	}
}

// The WebSocket carries the same envelope, and the broadcast path builds one
// payload for a whole room that can now hold both a member and a guest. A
// facilitator socket and the guest socket are both attached before the
// broadcast, so this also pins that the facilitator's own frame from that
// same broadcast is NOT redacted: the hub must fan out two different
// payloads to the same room, not silently collapse to one for everybody.
//
// The non-guest socket here is a second facilitator connection rather than
// Mel's own, deliberately: if Mel's socket were the one attached, her
// presence would make her legitimately visible to the guest too (presence
// is real "taking part", not a leak), which would defeat the very
// assertion this test exists to make.
func TestLinkGuestSocketEnvelopeHidesTheSpace(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{AllowedOrigin: testOrigin})
	fac, id, guest := mintAndRedeem(t, srv, "Envelope Socket Space")

	memberWS, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer memberWS.Close()
	if _, ok := readEnvelope(t, memberWS, 3*time.Second); !ok {
		t.Fatal("no initial frame for member")
	}

	guestWS, _, err := dialWS(t, srv, id, guest, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer guestWS.Close()
	if _, ok := readEnvelope(t, guestWS, 3*time.Second); !ok {
		t.Fatal("no initial frame for guest")
	}
	// A mutation the guest is entitled to see, so the frame under test is a
	// broadcast rather than the handshake's own initial state. Both sockets
	// are attached above, so this one broadcast reaches both.
	addStory(t, srv, id, "Story", fac)

	guestDeadline := time.Now().Add(3 * time.Second)
	for {
		env, ok := readEnvelope(t, guestWS, time.Until(guestDeadline))
		if !ok {
			t.Fatal("no broadcast frame reached the guest")
		}
		if env["title"] == nil {
			continue
		}
		if slug, _ := env["spaceSlug"].(string); slug != "" {
			t.Fatalf("broadcast frame to a guest carried spaceSlug %q", slug)
		}
		for _, p := range env["participants"].([]any) {
			if name := p.(map[string]any)["name"]; name == "Mel" {
				t.Fatal("broadcast frame to a guest carried an absent space member")
			}
		}
		break
	}

	memberDeadline := time.Now().Add(3 * time.Second)
	for {
		env, ok := readEnvelope(t, memberWS, time.Until(memberDeadline))
		if !ok {
			t.Fatal("no broadcast frame reached the member")
		}
		if env["title"] == nil {
			continue
		}
		if slug, _ := env["spaceSlug"].(string); slug == "" {
			t.Fatal("broadcast frame to a member lost spaceSlug")
		}
		sawMel := false
		for _, p := range env["participants"].([]any) {
			if name := p.(map[string]any)["name"]; name == "Mel" {
				sawMel = true
			}
		}
		if !sawMel {
			t.Fatal("broadcast frame to a member lost the space member Mel")
		}
		return
	}
}
