package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// standupLinkGuest mints a signed link for the room and redeems it under the
// given name, returning the guest's cookie and user id.
func standupLinkGuest(t *testing.T, srv *httptest.Server, sessionID, name string, fac *http.Cookie) (*http.Cookie, string) {
	t.Helper()
	resp, minted := mintLink(t, srv, sessionID, fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("mint: got %d (%v)", resp.StatusCode, minted)
	}
	token, _ := minted["token"].(string)
	if token == "" {
		t.Fatalf("mint returned no token: %v", minted)
	}
	r, body, guest := redeem(t, srv, token, name)
	if r.StatusCode != http.StatusCreated || guest == nil {
		t.Fatalf("redeem: got %d (%v)", r.StatusCode, body)
	}
	return guest, body["me"].(map[string]any)["id"].(string)
}

// A link guest redeemed into a standup holds no members row, so a roster built
// from members alone leaves it able to write an update that nobody ever calls
// on. It takes a turn like anybody else in the room — and still may not run
// the round: start/next/skip stay facilitator-only.
func TestStandupLinkGuestTakesATurn(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Guest Standup Space", "Amy", "Ben")
	fac, member := cookies[0], cookies[1]
	guest, guestID := standupLinkGuest(t, srv, id, "Gus", fac)

	defer closeAll(connectAll(t, srv, id, fac, member, guest))()

	// Running the round is the facilitator's alone, before and after start.
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", guest); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("guest start: got %d, want 403", resp.StatusCode)
	}
	for _, action := range []string{"next", "skip"} {
		if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/"+action, "", guest); resp.StatusCode != http.StatusForbidden {
			t.Fatalf("guest %s before start: got %d, want 403", action, resp.StatusCode)
		}
	}
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/actions/standup",
		`{"yesterday":"read the docs","today":"speak up","blockers":""}`, guest); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("guest update: got %d, want 204", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", guest); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("guest start after start: got %d, want 403", resp.StatusCode)
	}
	for _, action := range []string{"next", "skip"} {
		if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/"+action, "", guest); resp.StatusCode != http.StatusForbidden {
			t.Fatalf("guest %s after start: got %d, want 403", action, resp.StatusCode)
		}
	}

	// The guest's own update survived the roster insert rather than being
	// overwritten by it, and the guest speaks in roster order like anybody
	// else: Amy, Ben, Gus.
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", guest)
	// The round the guest is now part of still reaches it through the guest
	// redaction: the space slug is stripped, the roster is trimmed to the room,
	// and the standup state — which is not space data — arrives whole.
	if env["spaceSlug"] != "" {
		t.Errorf("the guest was shown the space slug: %v", env["spaceSlug"])
	}
	if len(standupState(env)["entries"].([]any)) != 3 {
		t.Errorf("the guest sees %v entries, want the whole round", standupState(env)["entries"])
	}
	for _, e := range standupState(env)["entries"].([]any) {
		entry := e.(map[string]any)
		if entry["userId"] == guestID && entry["today"] != "speak up" {
			t.Errorf("the guest's update was lost by start: %v", entry)
		}
	}
	assertRosterOrder(t, srv, id, fac, ids[0], ids[1], guestID)
}

// advance()'s "next entry after the current speaker's position" query never
// re-checks the current speaker's own liveness, so TestStandupRoundOutlives-
// ARevokedTurnHolder — which revokes the guest while it already holds the
// turn — cannot see a regression in how a *future* turn holder is handled.
// "Zed" sorts after both members, so its turn has not come up yet when the
// link is revoked: nothing is swept, and the round must still reach it.
func TestStandupRoundOutlivesARevokedFutureTurnHolder(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Revoked Future Turn Space", "Amy", "Ben")
	fac, member := cookies[0], cookies[1]
	resp, minted := mintLink(t, srv, id, fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("mint: got %d (%v)", resp.StatusCode, minted)
	}
	linkID := minted["id"].(string)
	r, body, guest := redeem(t, srv, minted["token"].(string), "Zed")
	if r.StatusCode != http.StatusCreated || guest == nil {
		t.Fatalf("redeem: got %d (%v)", r.StatusCode, body)
	}
	guestID := body["me"].(map[string]any)["id"].(string)

	defer closeAll(connectAll(t, srv, id, fac, member, guest))()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}
	// Revoke before the guest has ever held the turn.
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: %d", resp.StatusCode)
	}
	got := speakingOrder(t, srv, id, fac)
	want := []string{ids[0], ids[1], guestID}
	if len(got) != len(want) {
		t.Fatalf("the round skipped the revoked-but-unspoken guest: speaking order = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("speaking order = %v, want %v", got, want)
		}
	}
}

// rosterUsers' guest half is keyed on session_id — the only thing standing
// between one guest link and every standup roster in the space (D2). The HTTP
// surface independently pins a link guest to its one session
// (requireSessionMember), so this reaches past it and inserts session B's
// standup_entries row for session A's guest directly, the way a bug in an
// earlier step (or a future insert path that forgets the connected-presence
// gate) could leave it. What must not happen, regardless of how that row got
// there, is rosterUsers treating it as eligible to speak in session B.
func TestStandupRosterExcludesAGuestFromAnotherSession(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test"})

	cookiesA, _, sessionA := standupSpace(t, srv, "Guest Home Space", "Amy", "Ben")
	facA := cookiesA[0]
	_, guestID := standupLinkGuest(t, srv, sessionA, "Gus", facA)

	cookiesB, idsB, sessionB := standupSpace(t, srv, "Other Standup Space", "Cid", "Deb")
	facB, memberB := cookiesB[0], cookiesB[1]

	// Plant session A's guest directly into session B's roster, as if the
	// scoping predicate had already failed once.
	if _, err := pool.Exec(context.Background(), `
		insert into standup_entries (session_id, user_id, yesterday, position)
		values ($1, $2, '', 1)`, sessionB, guestID); err != nil {
		t.Fatalf("plant guest entry: %v", err)
	}

	defer closeAll(connectAll(t, srv, sessionB, facB, memberB))()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+sessionB+"/actions/start", "", facB); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}
	got := speakingOrder(t, srv, sessionB, facB)
	want := []string{idsB[0], idsB[1]}
	if len(got) != len(want) {
		t.Fatalf("session B's speaking order = %v, want %v (no session A guest)", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("session B's speaking order = %v, want %v", got, want)
		}
	}
	for _, u := range got {
		if u == guestID {
			t.Fatalf("session A's guest spoke in session B: %v", got)
		}
	}
}

// A link that expires or is revoked while its guest holds the turn must not
// strand the round on a speaker who can never speak. Nothing is swept — the
// guest keeps its slot and its written update, exactly as D5 says — and the
// facilitator advances past it with next, the same key that moves the round
// along for anybody who has gone quiet.
func TestStandupRoundOutlivesARevokedTurnHolder(t *testing.T) {
	srv := testServer(t)
	cookies, ids, id := standupSpace(t, srv, "Revoked Turn Space", "Bea", "Cal")
	fac, member := cookies[0], cookies[1]
	resp, minted := mintLink(t, srv, id, fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("mint: got %d (%v)", resp.StatusCode, minted)
	}
	linkID := minted["id"].(string)
	r, body, guest := redeem(t, srv, minted["token"].(string), "Abe")
	if r.StatusCode != http.StatusCreated || guest == nil {
		t.Fatalf("redeem: got %d (%v)", r.StatusCode, body)
	}
	guestID := body["me"].(map[string]any)["id"].(string)

	defer closeAll(connectAll(t, srv, id, fac, member, guest))()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/start", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if standupState(env)["currentSpeakerId"] != guestID {
		t.Fatalf("the guest sorts first by name and should hold the turn: %v", standupState(env)["currentSpeakerId"])
	}

	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: %d", resp.StatusCode)
	}
	got := speakingOrder(t, srv, id, fac)
	want := []string{guestID, ids[0], ids[1]}
	if len(got) != len(want) {
		t.Fatalf("the round stalled on the revoked guest: speaking order = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("speaking order = %v, want %v", got, want)
		}
	}
}
