package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func standupSetup(t *testing.T, srv *httptest.Server, spaceName string) (fac, m1, m2 *http.Cookie, sessionID, slug string) {
	t.Helper()
	fac = signup(t, srv, "Amy")
	m1 = signup(t, srv, "Ben")
	m2 = signup(t, srv, "Cal")
	_, sp := createSpace(t, srv, spaceName, fac)
	slug = sp["slug"].(string)
	for _, c := range []*http.Cookie{m1, m2} {
		if resp := joinSpace(t, srv, slug, c); resp.StatusCode != http.StatusNoContent {
			t.Fatalf("join: %d", resp.StatusCode)
		}
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/sessions",
		strings.NewReader(`{"kind":"standup","title":"Daily"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(fac)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var sess map[string]any
	jsonDecode(t, resp, &sess)
	return fac, m1, m2, sess["id"].(string), slug
}

func standupState(env map[string]any) map[string]any {
	return env["state"].(map[string]any)
}

func connectAll(t *testing.T, srv *httptest.Server, id string, cookies ...*http.Cookie) []*websocket.Conn {
	t.Helper()
	conns := []*websocket.Conn{}
	for _, c := range cookies {
		ws, _, err := dialWS(t, srv, id, c, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, ws)
	}
	time.Sleep(2 * time.Second)
	return conns
}

func TestStandupRoundRobinWithSkip(t *testing.T) {
	srv := testServer(t)
	fac, m1, m2, id, _ := standupSetup(t, srv, "Robin Space")
	conns := connectAll(t, srv, id, fac, m1, m2)
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/start", "", m1); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-facilitator start: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/start", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}

	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	st := standupState(env)
	entries := st["entries"].([]any)
	if len(entries) != 3 {
		t.Fatalf("snapshot entries: %d", len(entries))
	}
	if env["phase"] != "speaking" || st["currentSpeakerId"] == nil || st["speakerStartedAt"] == nil {
		t.Fatalf("start state wrong: phase=%v speaker=%v", env["phase"], st["currentSpeakerId"])
	}
	first := st["currentSpeakerId"].(string)

	// Skip the second speaker, advance through the rest, then done.
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/next", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("next: %d", resp.StatusCode)
	}
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	second := standupState(env)["currentSpeakerId"].(string)
	if second == first {
		t.Fatal("next did not advance")
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/skip", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("skip: %d", resp.StatusCode)
	}
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	st = standupState(env)
	third := st["currentSpeakerId"].(string)
	if third == second || third == first {
		t.Fatal("skip did not advance to the third speaker")
	}
	skippedCount := 0
	for _, e := range st["entries"].([]any) {
		if e.(map[string]any)["skipped"] == true {
			skippedCount++
		}
	}
	if skippedCount != 1 {
		t.Fatalf("skipped entries: %d", skippedCount)
	}

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/next", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("final next: %d", resp.StatusCode)
	}
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["phase"] != "done" || standupState(env)["currentSpeakerId"] != nil {
		t.Fatalf("wrap: phase=%v speaker=%v", env["phase"], standupState(env)["currentSpeakerId"])
	}
}

func TestStandupEntryUpsert(t *testing.T) {
	srv := testServer(t)
	fac, m1, _, id, _ := standupSetup(t, srv, "Entry Space")
	_ = fac

	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/standup",
		`{"yesterday":"shipped auth","today":"tests","blockers":"none"}`, m1); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("put entry: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/standup",
		`{"yesterday":"shipped auth","today":"tests + review","blockers":""}`, m1); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("second put: %d", resp.StatusCode)
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", m1)
	entries := standupState(env)["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("upsert created duplicates: %d", len(entries))
	}
	e := entries[0].(map[string]any)
	if e["today"] != "tests + review" || e["blockers"] != "" {
		t.Fatalf("update not applied: %v", e)
	}

	long := strings.Repeat("x", 2001)
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/standup",
		`{"yesterday":"`+long+`"}`, m1); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("2001-char field: %d", resp.StatusCode)
	}

	outsider := signup(t, srv, "Out")
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+id+"/standup", `{"today":"x"}`, outsider); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider put: %d", resp.StatusCode)
	}
}

func TestStandupCarryForward(t *testing.T) {
	srv := testServer(t)
	fac, m1, _, firstID, slug := standupSetup(t, srv, "Carry Space")

	// Yesterday's standup: Ben wrote a "today".
	if resp, _ := doJSON(t, srv, "PUT", "/api/sessions/"+firstID+"/standup",
		`{"yesterday":"","today":"finish the migration","blockers":""}`, m1); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("seed entry: %d", resp.StatusCode)
	}

	// Today's standup in the same space.
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/sessions",
		strings.NewReader(`{"kind":"standup","title":"Daily 2"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(fac)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var sess map[string]any
	jsonDecode(t, resp, &sess)
	secondID := sess["id"].(string)

	conns := connectAll(t, srv, secondID, fac, m1)
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+secondID+"/start", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start: %d", resp.StatusCode)
	}

	_, meBody := doJSON(t, srv, "GET", "/api/me", "", m1)
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+secondID, "", m1)
	for _, e := range standupState(env)["entries"].([]any) {
		entry := e.(map[string]any)
		if entry["userId"] == meBody["id"] {
			if entry["yesterday"] != "finish the migration" {
				t.Fatalf("carry-forward missing: %v", entry["yesterday"])
			}
			return
		}
	}
	t.Fatal("Ben not in the snapshot")
}
