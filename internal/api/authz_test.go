package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// closeSession ends a session as its facilitator and fails the test if the
// close itself did not take.
func closeSession(t *testing.T, srv *httptest.Server, id string, fac *http.Cookie) {
	t.Helper()
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id, "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("close: got %d, want 204", resp.StatusCode)
	}
}

// userID reads the caller's own id, which the transfer body needs.
func userID(t *testing.T, srv *httptest.Server, cookie *http.Cookie) string {
	t.Helper()
	_, me := doJSON(t, srv, "GET", "/api/me", "", cookie)
	id, ok := me["id"].(string)
	if !ok {
		t.Fatalf("me: no id in %v", me)
	}
	return id
}

func TestEndedSessionRejectsFacilitatorTransfer(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Ended Transfer Space")
	closeSession(t, srv, id, fac)

	resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator",
		`{"userId":"`+userID(t, srv, member)+`"}`, fac)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("transfer on ended session: got %d, want 409", resp.StatusCode)
	}
	if body["error"] != "this session has ended" {
		t.Fatalf("transfer on ended session: got error %q, want %q", body["error"], "this session has ended")
	}
}

func TestEndedSessionRejectsFacilitatorClaim(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Ended Claim Space")
	closeSession(t, srv, id, fac)

	resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/facilitator/claim", "", member)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("claim on ended session: got %d, want 409", resp.StatusCode)
	}
	if body["error"] != "this session has ended" {
		t.Fatalf("claim on ended session: got error %q, want %q", body["error"], "this session has ended")
	}
}

// TestEndedSessionStillReadable pins the deliberate exceptions: an ended
// session is still readable and exportable, and reopen is the one write whose
// whole purpose is an ended session.
func TestEndedSessionStillReadable(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Ended Read Space")
	closeSession(t, srv, id, fac)

	resp, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", member)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("read ended session: got %d, want 200", resp.StatusCode)
	}
	if env["endedAt"] == nil {
		t.Fatal("read ended session: endedAt was not set")
	}

	req, _ := http.NewRequest("GET", srv.URL+"/api/sessions/"+id+"/export.csv", nil)
	req.AddCookie(member)
	csv, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	csv.Body.Close()
	if csv.StatusCode != http.StatusOK {
		t.Fatalf("export ended session: got %d, want 200", csv.StatusCode)
	}

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/reopen", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reopen ended session: got %d, want 204", resp.StatusCode)
	}
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", member)
	if env["endedAt"] != nil {
		t.Fatal("reopen did not clear endedAt")
	}
}

// TestClosingAnAlreadyClosedSessionIsIdempotent pins close as a no-op on a
// session that has already ended: a retried or double-clicked DELETE must not
// show the facilitator an error for an action that already succeeded.
func TestClosingAnAlreadyClosedSessionIsIdempotent(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Idempotent Close Space")
	closeSession(t, srv, id, fac)

	resp, body := doJSON(t, srv, "DELETE", "/api/sessions/"+id, "", fac)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("second close: got %d, want 204 (idempotent); body=%v", resp.StatusCode, body)
	}

	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", member)
	if env["endedAt"] == nil {
		t.Fatal("second close: session is no longer ended")
	}
}
