package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func mintLink(t *testing.T, srv *httptest.Server, sessionID string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	return doJSON(t, srv, "POST", "/api/sessions/"+sessionID+"/links", "{}", cookie)
}

func TestMintSessionLinkReturnsTheTokenExactlyOnce(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Links Space")

	resp, body := mintLink(t, srv, id, fac)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("mint: got %d, want 201 (%v)", resp.StatusCode, body)
	}
	token, _ := body["token"].(string)
	if token == "" {
		t.Fatalf("mint returned no token: %v", body)
	}
	linkID, _ := body["id"].(string)
	if linkID == "" {
		t.Fatalf("mint returned no id: %v", body)
	}

	// The token is never readable again — not by the facilitator who minted
	// it, and not by any other member.
	for name, cookie := range map[string]*http.Cookie{"facilitator": fac, "member": member} {
		resp, list := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", cookie)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s list: got %d, want 200", name, resp.StatusCode)
		}
		links, _ := list["links"].([]any)
		if len(links) != 1 {
			t.Fatalf("%s list = %v, want one link", name, list)
		}
		entry := links[0].(map[string]any)
		if _, ok := entry["token"]; ok {
			t.Fatalf("%s list leaked a token: %v", name, entry)
		}
		if entry["redemptions"].(float64) != 0 {
			t.Fatalf("%s list redemptions = %v, want 0", name, entry["redemptions"])
		}
	}
}

func TestSessionLinkAuthz(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Link Authz Space")
	outsider := signup(t, srv, "Out")

	if resp, _ := mintLink(t, srv, id, member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member mint: got %d, want 403", resp.StatusCode)
	}
	if resp, _ := mintLink(t, srv, id, outsider); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider mint: got %d, want 404", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", outsider); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider list: got %d, want 404", resp.StatusCode)
	}

	_, body := mintLink(t, srv, id, fac)
	linkID := body["id"].(string)
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member revoke: got %d, want 403", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", outsider); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider revoke: got %d, want 404", resp.StatusCode)
	}
}

func TestRevokeSessionLinkIsIdempotent(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Link Revoke Space")

	_, body := mintLink(t, srv, id, fac)
	linkID := body["id"].(string)
	for i := 0; i < 2; i++ {
		if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id+"/links/"+linkID, "", fac); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("revoke %d: got %d, want 204", i, resp.StatusCode)
		}
	}
	// A revoked link stays on the list, marked, rather than vanishing: the
	// facilitator has to be able to see that the link they handed out is dead.
	_, list := doJSON(t, srv, "GET", "/api/sessions/"+id+"/links", "", fac)
	entry := list["links"].([]any)[0].(map[string]any)
	if entry["revokedAt"] == nil {
		t.Fatalf("revoked link listed as live: %v", entry)
	}
}

func TestMintSessionLinkRefusedOnAnEndedSession(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Link Ended Space")

	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("close session: got %d", resp.StatusCode)
	}
	if resp, _ := mintLink(t, srv, id, fac); resp.StatusCode != http.StatusConflict {
		t.Fatalf("mint on ended session: got %d, want 409", resp.StatusCode)
	}
}

func TestMintSessionLinkHoldsThePerSessionCap(t *testing.T) {
	srv, _ := quotaServer(t, Limits{LinksPerSession: 1})
	fac, _, id := setupSession(t, srv, "Link Cap Space")

	if resp, _ := mintLink(t, srv, id, fac); resp.StatusCode != http.StatusCreated {
		t.Fatalf("first mint: got %d, want 201", resp.StatusCode)
	}
	if resp, _ := mintLink(t, srv, id, fac); resp.StatusCode != http.StatusConflict {
		t.Fatalf("second mint: got %d, want 409", resp.StatusCode)
	}
}
