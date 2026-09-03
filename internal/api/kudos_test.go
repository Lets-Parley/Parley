package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func listKudos(t *testing.T, srv *httptest.Server, slug string, cookie *http.Cookie) (*http.Response, []map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/orgs/default/spaces/"+slug+"/kudos", nil)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	return resp, out
}

func giveKudo(t *testing.T, srv *httptest.Server, slug, body string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	return doJSON(t, srv, http.MethodPost, "/api/orgs/default/spaces/"+slug+"/kudos", body, cookie)
}

// kudoSpace is an owner and two joined members: a sender, a recipient and a
// third pair of hands for the "not the sender" cases.
func kudoSpace(t *testing.T, srv *httptest.Server) (owner, member, other *http.Cookie, memberID, slug string) {
	t.Helper()
	owner = signup(t, srv, "Owner")
	_, sp := createSpace(t, srv, "Kudo Space", owner)
	slug = sp["slug"].(string)
	passcode := sp["passcode"].(string)
	member, memberID = signupWithID(t, srv, "Member")
	other = signup(t, srv, "Other")
	for _, c := range []*http.Cookie{member, other} {
		if resp := joinSpace(t, srv, slug, c, passcode); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("join: got %d", resp.StatusCode)
		}
	}
	return owner, member, other, memberID, slug
}

// The response carries the kudo and nothing that could be summed: no totals,
// no counts, no rankings. THERE IS NO LEADERBOARD.
func TestKudoResponseCarriesNoTotals(t *testing.T) {
	srv := testServer(t)
	owner, _, _, memberID, slug := kudoSpace(t, srv)

	resp, kudo := giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":"thank you for the review"}`, owner)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d (%v)", resp.StatusCode, kudo)
	}
	want := map[string]bool{"id": true, "fromUserId": true, "toUserId": true, "text": true, "createdAt": true, "sessionId": true}
	for k := range kudo {
		if !want[k] {
			t.Fatalf("unexpected field %q in %v", k, kudo)
		}
	}
	for _, k := range []string{"id", "fromUserId", "toUserId", "text", "createdAt"} {
		if kudo[k] == nil {
			t.Fatalf("missing field %q in %v", k, kudo)
		}
	}

	_, kudos := listKudos(t, srv, slug, owner)
	if len(kudos) != 1 || kudos[0]["text"] != "thank you for the review" {
		t.Fatalf("list: got %v", kudos)
	}
	for k := range kudos[0] {
		if !want[k] {
			t.Fatalf("unexpected field %q on the wall: %v", k, kudos[0])
		}
	}
}

func TestKudoTextIsMeasuredInRunes(t *testing.T) {
	srv := testServer(t)
	owner, _, _, memberID, slug := kudoSpace(t, srv)

	resp, body := giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":"`+strings.Repeat("é", 280)+`"}`, owner)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("280 runes: got %d (%v)", resp.StatusCode, body)
	}
	resp, body = giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":"`+strings.Repeat("a", 281)+`"}`, owner)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("281 runes: got %d (%v), want 400", resp.StatusCode, body)
	}
	if msg, _ := body["error"].(string); msg == "" {
		t.Fatalf("281 runes: no readable message in %v", body)
	}
	if resp, body := giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":""}`, owner); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty text: got %d (%v), want 400", resp.StatusCode, body)
	}
}

// A guest holds a users row but no members row, so nothing in the schema
// catches it — and a non-member recipient must never be a 500.
func TestKudoToAGuestOrANonMemberIsRefused(t *testing.T) {
	srv := testServer(t)
	owner, _, _, _, slug := kudoSpace(t, srv)
	_, strangerID := signupWithID(t, srv, "Stranger")

	for _, to := range []string{strangerID, "not-a-uuid", "00000000-0000-0000-0000-000000000000"} {
		resp, body := giveKudo(t, srv, slug, `{"to":"`+to+`","text":"thanks"}`, owner)
		if resp.StatusCode != http.StatusBadRequest && resp.StatusCode != http.StatusNotFound {
			t.Fatalf("recipient %q: got %d (%v), want 400 or 404", to, resp.StatusCode, body)
		}
	}
}

func TestSelfKudoIsRefused(t *testing.T) {
	srv := testServer(t)
	owner, _, _, _, slug := kudoSpace(t, srv)
	_, meBody := doJSON(t, srv, http.MethodGet, "/api/me", "", owner)
	me := meBody["id"].(string)
	resp, body := giveKudo(t, srv, slug, `{"to":"`+me+`","text":"thanks, me"}`, owner)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("self kudo: got %d (%v), want 400", resp.StatusCode, body)
	}
}

func TestOnlyTheSenderWithdrawsAKudo(t *testing.T) {
	srv := testServer(t)
	owner, member, other, memberID, slug := kudoSpace(t, srv)
	_, kudo := giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":"thank you"}`, owner)
	id := kudo["id"].(string)
	path := "/api/orgs/default/spaces/" + slug + "/kudos/" + id

	// The recipient may not withdraw it, and neither may a bystander.
	for name, c := range map[string]*http.Cookie{"recipient": member, "bystander": other} {
		if resp, body := doJSON(t, srv, http.MethodDelete, path, "", c); resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s delete: got %d (%v), want 403", name, resp.StatusCode, body)
		}
	}
	if resp, body := doJSON(t, srv, http.MethodDelete,
		"/api/orgs/default/spaces/"+slug+"/kudos/00000000-0000-0000-0000-000000000000", "", owner); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("missing kudo delete: got %d (%v), want 404", resp.StatusCode, body)
	}
	if resp, body := doJSON(t, srv, http.MethodDelete, path, "", owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("sender delete: got %d (%v), want 204", resp.StatusCode, body)
	}
	if _, kudos := listKudos(t, srv, slug, owner); len(kudos) != 0 {
		t.Fatalf("withdrawn kudo still on the wall: %v", kudos)
	}
}

// A kudo id from another space is not reachable from this one.
func TestKudoIDFromAnotherSpaceIsNotReachable(t *testing.T) {
	srv := testServer(t)
	owner, _, _, memberID, slug := kudoSpace(t, srv)
	_, kudo := giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":"thank you"}`, owner)
	id := kudo["id"].(string)

	_, b := createSpace(t, srv, "Other Space", owner)
	path := "/api/orgs/default/spaces/" + b["slug"].(string) + "/kudos/" + id
	if resp, body := doJSON(t, srv, http.MethodDelete, path, "", owner); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-space delete: got %d (%v), want 404", resp.StatusCode, body)
	}
	if _, kudos := listKudos(t, srv, slug, owner); len(kudos) != 1 {
		t.Fatalf("kudo was reachable from another space: %v", kudos)
	}
}

// A non-member is told nothing about the space, on every verb.
func TestNonMemberGets404OnKudos(t *testing.T) {
	srv := testServer(t)
	owner, _, _, memberID, slug := kudoSpace(t, srv)
	_, kudo := giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":"thank you"}`, owner)
	id := kudo["id"].(string)

	stranger := signup(t, srv, "Stranger")
	if resp, _ := listKudos(t, srv, slug, stranger); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("stranger list: got %d, want 404", resp.StatusCode)
	}
	if resp, _ := giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":"hi"}`, stranger); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("stranger create: got %d, want 404", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, http.MethodDelete, "/api/orgs/default/spaces/"+slug+"/kudos/"+id, "", stranger); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("stranger delete: got %d, want 404", resp.StatusCode)
	}
}

// A link guest is refused 401 rather than 403: under RequireUser it is turned
// away before any space middleware runs.
func TestLinkGuestGets401OnKudos(t *testing.T) {
	srv := testServer(t)
	_, _, _, _, slug := kudoSpace(t, srv)
	cookies, _, sessionID := standupSpace(t, srv, "Guest Kudo Space", "Amy", "Ben")
	guest, _ := standupLinkGuest(t, srv, sessionID, "Gus", cookies[0])

	if resp, _ := listKudos(t, srv, slug, guest); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("guest list: got %d, want 401", resp.StatusCode)
	}
	if resp, _ := giveKudo(t, srv, slug, `{"to":"x","text":"hi"}`, guest); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("guest create: got %d, want 401", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, http.MethodDelete,
		"/api/orgs/default/spaces/"+slug+"/kudos/00000000-0000-0000-0000-000000000000", "", guest); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("guest delete: got %d, want 401", resp.StatusCode)
	}
}

func TestKudoCapReturnsAClear4xx(t *testing.T) {
	srv := testServerWith(t, testPool(t), Options{AllowedOrigin: testOrigin, Limits: Limits{KudosPerSpace: 1}})
	owner, _, _, memberID, slug := kudoSpace(t, srv)
	if resp, body := giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":"first"}`, owner); resp.StatusCode != http.StatusCreated {
		t.Fatalf("first: got %d (%v)", resp.StatusCode, body)
	}
	resp, body := giveKudo(t, srv, slug, `{"to":"`+memberID+`","text":"second"}`, owner)
	if resp.StatusCode < 400 || resp.StatusCode >= 500 {
		t.Fatalf("over-cap: got %d (%v), want a 4xx", resp.StatusCode, body)
	}
}
