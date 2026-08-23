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
