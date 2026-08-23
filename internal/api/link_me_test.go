package api

import (
	"net/http"
	"testing"
)

// TestLinkGuestCanReadOwnIdentity pins the one thing a link guest may read
// about itself. A guest whose browser storage is gone — a private window, a
// cleared site, a second device — has nothing left but the cookie, and without
// a way to turn that cookie back into "who am I and which room am I bound to"
// it lands in the name gate, whose POST it is then refused. That is a dead end,
// so the read is open.
func TestLinkGuestCanReadOwnIdentity(t *testing.T) {
	srv := testServer(t)
	_, id, guest := mintAndRedeem(t, srv, "Guest Me Space")

	resp, body := doJSON(t, srv, "GET", "/api/me", "", guest)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/me as a link guest: got %d, want 200 (%v)", resp.StatusCode, body)
	}
	if body["linkSessionId"] != id {
		t.Errorf("linkSessionId = %v, want %s", body["linkSessionId"], id)
	}
	if body["name"] != "Gus" {
		t.Errorf("name = %v, want Gus", body["name"])
	}
	if s, _ := body["linkExpiresAt"].(string); s == "" {
		t.Error("linkExpiresAt is empty — the guest cannot say when its seat runs out")
	}
	if _, ok := body["id"].(string); !ok {
		t.Error("no user id")
	}
	// The whole grant, and nothing beyond it: no space, no slug, no roster, no
	// other session. Any field added here must be one the guest already sees.
	allowed := map[string]bool{
		"id": true, "name": true, "avatarHue": true, "avatarIcon": true,
		"linkSessionId": true, "linkExpiresAt": true,
	}
	for k := range body {
		if !allowed[k] {
			t.Errorf("GET /api/me leaks %q to a link guest", k)
		}
	}
}

// An ordinary account is not a link guest, and must not be described as one:
// the frontend decides whether to render the guest banner from these fields.
func TestOrdinaryUserHasNoLinkFieldsOnMe(t *testing.T) {
	srv := testServer(t)
	fac := signup(t, srv, "Fay")

	resp, body := doJSON(t, srv, "GET", "/api/me", "", fac)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/me: got %d, want 200 (%v)", resp.StatusCode, body)
	}
	if _, ok := body["linkSessionId"]; ok {
		t.Errorf("linkSessionId present for an ordinary user: %v", body["linkSessionId"])
	}
	if _, ok := body["linkExpiresAt"]; ok {
		t.Errorf("linkExpiresAt present for an ordinary user: %v", body["linkExpiresAt"])
	}
}
