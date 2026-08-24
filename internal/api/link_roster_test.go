package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"
)

// participantNames pulls the roster names out of an envelope body, sorted.
func participantNames(t *testing.T, env map[string]any) []string {
	t.Helper()
	out := []string{}
	for _, p := range env["participants"].([]any) {
		out = append(out, p.(map[string]any)["name"].(string))
	}
	sort.Strings(out)
	return out
}

// redeemAs redeems a token and fails the test unless a guest identity comes back.
func redeemAs(t *testing.T, srv *httptest.Server, token, name string) *http.Cookie {
	t.Helper()
	resp, body, cookie := redeem(t, srv, token, name)
	if resp.StatusCode != http.StatusCreated || cookie == nil {
		t.Fatalf("redeem as %s: got %d (%v)", name, resp.StatusCode, body)
	}
	return cookie
}

// TestLinkGuestsSitAtTheTable pins both halves of the roster: a link guest is
// a seat everybody in the room can see, and a guest's own redacted copy shows
// the guest itself and the other guest taking part — but still not a space
// member who is nowhere near the meeting.
func TestLinkGuestsSitAtTheTable(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{AllowedOrigin: testOrigin})
	fac, _, id := setupSession(t, srv, "Guest Roster Space")
	_, minted := mintLink(t, srv, id, fac)
	token := minted["token"].(string)
	gus := redeemAs(t, srv, token, "Gus")
	ada := redeemAs(t, srv, token, "Ada")

	for _, c := range []*http.Cookie{gus, ada} {
		ws, _, err := dialWS(t, srv, id, c, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		defer ws.Close()
		if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
			t.Fatal("no initial frame")
		}
	}

	_, facEnv := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, facEnv); !slices.Equal(got, []string{"Ada", "Fay", "Gus", "Mel"}) {
		t.Fatalf("member participants = %v, want the members and both guests", got)
	}
	for _, p := range facEnv["participants"].([]any) {
		e := p.(map[string]any)
		if e["name"] == "Gus" && e["spectator"] != false {
			t.Fatalf("guest seat spectator = %v, want false", e["spectator"])
		}
	}

	_, guestEnv := doJSON(t, srv, "GET", "/api/sessions/"+id, "", gus)
	if got := participantNames(t, guestEnv); !slices.Equal(got, []string{"Ada", "Fay", "Gus"}) {
		t.Fatalf("guest participants = %v, want itself, the other guest and the facilitator", got)
	}
}

// TestCSVKeepsAGuestNameAfterTheLinkDies is the feature-level promise: revoking
// or expiring a link never removes a name from a CSV. The export roster is
// therefore every guest the room ever admitted, not the live one.
func TestCSVKeepsAGuestNameAfterTheLinkDies(t *testing.T) {
	srv := testServer(t)
	fac, id, guest := mintAndRedeem(t, srv, "Guest CSV Space")
	story := addStory(t, srv, id, "Guest story", fac)
	selectStory(t, srv, id, story, fac)
	if resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/vote",
		`{"storyId":"`+story+`","value":"5"}`, guest); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("guest vote: got %d (%v)", resp.StatusCode, body)
	}
	doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac)

	if _, body := fetchCSV(t, srv, id, fac); !strings.Contains(body, "Gus: 5") {
		t.Fatalf("live-link export missing the guest's name:\n%s", body)
	}

	_, list := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", fac)
	linkID := list["links"].([]any)[0].(map[string]any)["id"].(string)
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: got %d, want 204", resp.StatusCode)
	}
	if _, body := fetchCSV(t, srv, id, fac); !strings.Contains(body, "Gus: 5") {
		t.Fatalf("export after revocation lost the guest's name:\n%s", body)
	}

	// And expiry, which is the other way a link stops being live.
	if _, err := testDBPool(t).Exec(context.Background(),
		"update session_links set revoked_at = null, expires_at = now() - interval '1 day' where id = $1", linkID); err != nil {
		t.Fatal(err)
	}
	if _, body := fetchCSV(t, srv, id, fac); !strings.Contains(body, "Gus: 5") {
		t.Fatalf("export after expiry lost the guest's name:\n%s", body)
	}
}

// TestLiveRosterDropsAGuestWhenTheLinkDies is the mirror of
// TestCSVKeepsAGuestNameAfterTheLinkDies on the live path: BuildEnvelope
// unions in only unrevoked, unexpired links (AC 1 of #295), so once a link
// is revoked or expired the guest it seated must disappear from
// GET /api/sessions/{id}'s participants, even though the same name stays in
// the CSV forever.
func TestLiveRosterDropsAGuestWhenTheLinkDies(t *testing.T) {
	srv := testServer(t)
	fac, id, _ := mintAndRedeem(t, srv, "Guest Live Roster Space")

	_, facEnv := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, facEnv); !slices.Contains(got, "Gus") {
		t.Fatalf("participants = %v, want Gus seated while the link is live", got)
	}

	_, list := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", fac)
	linkID := list["links"].([]any)[0].(map[string]any)["id"].(string)
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: got %d, want 204", resp.StatusCode)
	}
	_, facEnv = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, facEnv); slices.Contains(got, "Gus") {
		t.Fatalf("participants = %v, want Gus gone after revocation", got)
	}

	// Mint a second link, seat a second guest, then let it expire rather
	// than revoking it — revoked and expired are separate terms in the
	// predicate, so a test for one does not pin the other.
	_, minted := mintLink(t, srv, id, fac)
	token, _ := minted["token"].(string)
	if token == "" {
		t.Fatalf("mint returned no token: %v", minted)
	}
	redeemAs(t, srv, token, "Elle")
	_, facEnv = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, facEnv); !slices.Contains(got, "Elle") {
		t.Fatalf("participants = %v, want Elle seated while her link is live", got)
	}

	_, list = doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", fac)
	var elleLinkID string
	for _, l := range list["links"].([]any) {
		m := l.(map[string]any)
		if m["id"].(string) != linkID {
			elleLinkID = m["id"].(string)
		}
	}
	if elleLinkID == "" {
		t.Fatalf("could not find Elle's link among: %v", list)
	}
	if _, err := testDBPool(t).Exec(context.Background(),
		"update session_links set expires_at = now() - interval '1 day' where id = $1", elleLinkID); err != nil {
		t.Fatal(err)
	}
	_, facEnv = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, facEnv); slices.Contains(got, "Elle") {
		t.Fatalf("participants = %v, want Elle gone after her link expired", got)
	}
}

// TestLinkRosterIsScopedToItsOwnSession pins the session_id binding in the
// guest half of roster()'s union: a guest bound to one session in a space
// must never appear in a different session's roster in the same space, even
// though both sessions share the same space_id.
func TestLinkRosterIsScopedToItsOwnSession(t *testing.T) {
	srv := testServer(t)
	fac, slug, sessionA, _ := mintAndRedeemIn(t, srv, "Roster Scope Space")

	resp, sessB := createSession(t, srv, slug, "poker", "Second Meeting", fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create second session: %d %v", resp.StatusCode, sessB)
	}
	sessionBID := sessB["id"].(string)

	_, envA := doJSON(t, srv, "GET", "/api/sessions/"+sessionA, "", fac)
	if got := participantNames(t, envA); !slices.Equal(got, []string{"Fay", "Gus"}) {
		t.Fatalf("session A participants = %v, want [Fay Gus]", got)
	}

	_, envB := doJSON(t, srv, "GET", "/api/sessions/"+sessionBID, "", fac)
	if got := participantNames(t, envB); !slices.Equal(got, []string{"Fay"}) {
		t.Fatalf("session B participants = %v, want just [Fay]: a guest bound to session A must not leak into session B's roster", got)
	}
}

// TestGuestWearingAMemberNameIsStillMarkedAGuest is the impersonation guard of
// #296: nothing stops a guest redeeming as "Fay", so the roster has to say
// which "Fay" is which. The mark is the server's, not a client convention, and
// it holds in OIDC mode too, where display names are provider-owned for real
// users and a freely-chosen guest name is the sharper edge.
func TestGuestWearingAMemberNameIsStillMarkedAGuest(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, _, id := setupSession(t, srv, "Impersonation Space")
	_, minted := mintLink(t, srv, id, fac)
	token := minted["token"].(string)

	federated := testServerWith(t, pool, Options{AllowedOrigin: testOrigin, AuthMode: ModeOIDC})
	guest := redeemAs(t, federated, token, "Fay")

	// The facilitator reads the room on the open-mode server — an OIDC-mode
	// instance answers no session cookie but the guest's own, which is the
	// next check.
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	guests, members := 0, 0
	for _, p := range env["participants"].([]any) {
		e := p.(map[string]any)
		if e["name"] != "Fay" {
			continue
		}
		if e["guest"] == true {
			guests++
		} else {
			members++
		}
	}
	if guests != 1 || members != 1 {
		t.Fatalf("two people called Fay = %d guest / %d member, want 1 and 1: %v", guests, members, env["participants"])
	}

	// And the guest's own redacted copy still marks it, so a guest cannot read
	// its own seat as a member's either. The socket is what puts the guest in
	// its own redacted roster; the facilitator — also called Fay — is in it
	// either way, which is exactly the pair the mark has to separate.
	ws, _, err := dialWS(t, federated, id, guest, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}
	_, meBody := doJSON(t, federated, "GET", "/api/me", "", guest)
	guestID := meBody["id"].(string)
	// Presence lands a moment after the socket is accepted, so poll rather
	// than race it.
	var own map[string]any
	seen := 0
	for range 40 {
		_, own = doJSON(t, federated, "GET", "/api/sessions/"+id, "", guest)
		seen = 0
		for _, p := range own["participants"].([]any) {
			e := p.(map[string]any)
			if e["userId"] != guestID {
				continue
			}
			seen++
			if e["guest"] != true {
				t.Fatalf("guest's own redacted seat = %v, want guest true", e)
			}
		}
		if seen == 1 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if seen != 1 {
		t.Fatalf("guest's own seat appears %d times in its redacted roster, want once: %v", seen, own["participants"])
	}
}

// TestLinkGuestSeesItsOwnSeatWithNoSocket pins the first paint of a room: a
// guest that has redeemed a link but not yet opened a socket has no presence
// row, and used to be filtered out of its own room until the socket settled.
// The redaction rule is presence ∪ facilitator ∪ self, so the guest's own seat
// is there from the very first GET — and a member who is nowhere near the
// meeting still is not.
func TestLinkGuestSeesItsOwnSeatWithNoSocket(t *testing.T) {
	srv := testServer(t)
	_, id, guest := mintAndRedeem(t, srv, "First Paint Space")

	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", guest)
	got := participantNames(t, env)
	if !slices.Contains(got, "Gus") {
		t.Fatalf("participants = %v, want the guest's own seat with no socket open", got)
	}
	if slices.Contains(got, "Mel") {
		t.Fatalf("participants = %v, want an absent member still hidden from a guest", got)
	}
}

// TestGuestSocketSeesItselfInItsFirstFrame pins the identity the websocket
// handler hands to RedactForGuest. The initial envelope is built and redacted
// before the socket is attached, so the guest has no presence row yet: the
// only thing keeping it on its own roster is that the call site passes the
// guest's own id. Pass anything else — the facilitator's id, a room id — and
// the guest is redacted out of its own first frame.
//
// No other test catches this, because every other guest socket registers
// presence before anything is asserted, which masks the argument entirely.
func TestGuestSocketSeesItselfInItsFirstFrame(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test"})
	_, id, guest := mintAndRedeem(t, srv, "Guest First Frame Space")

	// This test's whole point is that the first frame is built and redacted
	// before the guest has a presence row, so the RedactForGuest(selfID)
	// argument is the only thing keeping the guest on its own roster (see the
	// comment above). If a future reordering registers presence before the
	// envelope is redacted, this guard - not the assertion below - is what
	// catches it: without it, the guest would already be present and the
	// redaction argument would go unexercised while the test kept passing.
	var presentBeforeFirstFrame int
	if err := pool.QueryRow(context.Background(),
		`select count(*) from session_presence where session_id = $1`, id,
	).Scan(&presentBeforeFirstFrame); err != nil {
		t.Fatal(err)
	}
	if presentBeforeFirstFrame != 0 {
		t.Fatalf("session already has %d presence row(s) before the guest's socket opened; "+
			"this test only exercises the RedactForGuest(selfID) argument because the guest has "+
			"no presence row yet when its first frame is built - if presence registration has "+
			"moved ahead of that redaction, the guest would already be present and this test "+
			"would keep passing without catching a wrong identity being passed in", presentBeforeFirstFrame)
	}

	ws, _, err := dialWS(t, srv, id, guest, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	env, ok := readEnvelope(t, ws, 3*time.Second)
	if !ok {
		t.Fatal("no initial frame")
	}
	if got := participantNames(t, env); !slices.Contains(got, "Gus") {
		t.Fatalf("guest's first frame participants = %v, want it to contain the guest itself; "+
			"the websocket call site is redacting with the wrong identity", got)
	}
}
