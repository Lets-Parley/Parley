package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func addStory(t *testing.T, srv *httptest.Server, sessionID, title string, c *http.Cookie) string {
	t.Helper()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+sessionID+"/stories",
		`{"title":"`+title+`"}`, c); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("add story: %d", resp.StatusCode)
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+sessionID, "", c)
	stories := env["state"].(map[string]any)["stories"].([]any)
	return stories[len(stories)-1].(map[string]any)["id"].(string)
}

func selectStory(t *testing.T, srv *httptest.Server, sessionID, storyID string, c *http.Cookie) {
	t.Helper()
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+sessionID+"/select",
		`{"storyId":"`+storyID+`"}`, c); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("select story: %d", resp.StatusCode)
	}
}

func vote(t *testing.T, srv *httptest.Server, storyID, value string, c *http.Cookie) *http.Response {
	t.Helper()
	resp, _ := doJSON(t, srv, "POST", "/api/stories/"+storyID+"/vote", `{"value":"`+value+`"}`, c)
	return resp
}

func currentStory(env map[string]any, storyID string) map[string]any {
	for _, s := range env["state"].(map[string]any)["stories"].([]any) {
		st := s.(map[string]any)
		if st["id"] == storyID {
			return st
		}
	}
	return nil
}

func TestVoteGuards(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Guard Space")
	story := addStory(t, srv, id, "Login page", fac)
	other := addStory(t, srv, id, "Other story", fac)
	selectStory(t, srv, id, story, fac)

	// Value not in deck.
	if resp := vote(t, srv, story, "99", member); resp.StatusCode != http.StatusConflict {
		t.Fatalf("bad value: %d", resp.StatusCode)
	}
	// Voting on a non-current story.
	if resp := vote(t, srv, other, "5", member); resp.StatusCode != http.StatusConflict {
		t.Fatalf("non-current story: %d", resp.StatusCode)
	}
	// Spectator cannot vote.
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/spectator", `{"on":true}`, member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectator toggle: %d", resp.StatusCode)
	}
	if resp := vote(t, srv, story, "5", member); resp.StatusCode != http.StatusConflict {
		t.Fatalf("spectator vote: %d", resp.StatusCode)
	}
	doJSON(t, srv, "POST", "/api/sessions/"+id+"/spectator", `{"on":false}`, member)

	// Valid vote, then reveal, then voting is closed.
	if resp := vote(t, srv, story, "5", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("valid vote: %d", resp.StatusCode)
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/reveal", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reveal: %d", resp.StatusCode)
	}
	if resp := vote(t, srv, story, "8", member); resp.StatusCode != http.StatusConflict {
		t.Fatalf("post-reveal vote: %d", resp.StatusCode)
	}

	// Reveal/reset are facilitator-only.
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/reset", "", member); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("member reset: %d", resp.StatusCode)
	}
	// Non-member sees nothing.
	outsider := signup(t, srv, "Out")
	if resp := vote(t, srv, story, "5", outsider); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("outsider vote: %d", resp.StatusCode)
	}
}

func TestRedactionBeforeReveal(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Redact Space")
	story := addStory(t, srv, id, "Secret votes", fac)
	selectStory(t, srv, id, story, fac)

	// Facilitator connects too, so the lone voter can't trip auto-reveal.
	wsFac, _, err := dialWS(t, srv, id, fac, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer wsFac.Close()
	ws, _, err := dialWS(t, srv, id, member, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if _, ok := readEnvelope(t, ws, 3*time.Second); !ok {
		t.Fatal("no initial frame")
	}
	time.Sleep(1800 * time.Millisecond) // presence settle: both count in the denominator

	if resp := vote(t, srv, story, "13", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote: %d", resp.StatusCode)
	}

	// REST payload: voter listed, value absent — for the voter themselves too.
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", member)
	st := currentStory(env, story)
	if len(st["votedUserIds"].([]any)) != 1 {
		t.Fatalf("votedUserIds: %v", st["votedUserIds"])
	}
	if _, has := st["votes"]; has {
		t.Fatal("REST payload leaked vote values before reveal")
	}

	// WS frame to the voter: same rule.
	deadline := time.Now().Add(5 * time.Second)
	sawVote := false
	for time.Now().Before(deadline) && !sawVote {
		frame, ok := readEnvelope(t, ws, time.Until(deadline))
		if !ok {
			break
		}
		raw := frame["state"].(map[string]any)
		for _, s := range raw["stories"].([]any) {
			stf := s.(map[string]any)
			if stf["id"] != story {
				continue
			}
			if _, has := stf["votes"]; has {
				t.Fatal("WS frame leaked vote values before reveal")
			}
			if len(stf["votedUserIds"].([]any)) == 1 {
				sawVote = true
			}
		}
	}
	if !sawVote {
		t.Fatal("WS frame never reflected the vote")
	}

	// After reveal, values and stats appear.
	doJSON(t, srv, "POST", "/api/sessions/"+id+"/reveal", "", fac)
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", member)
	st = currentStory(env, story)
	if _, has := st["votes"]; !has {
		t.Fatal("revealed payload missing votes")
	}
	if st["results"].(map[string]any)["histogram"] == nil {
		t.Fatal("revealed payload missing histogram")
	}
}

func TestAutoRevealOnlyOnVoteEvents(t *testing.T) {
	srv := testServer(t)
	fac, m1, id := setupSession(t, srv, "Auto Space")
	m2 := signup(t, srv, "Third")
	_, auto := doJSON(t, srv, "GET", "/api/spaces/auto-space", "", m1)
	autoCode, _ := auto["passcode"].(string)
	if resp := joinSpace(t, srv, "auto-space", m2, autoCode); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	story := addStory(t, srv, id, "Auto story", fac)
	selectStory(t, srv, id, story, fac)

	// Three connected, non-spectator members.
	conns := []*websocket.Conn{}
	for _, c := range []*http.Cookie{fac, m1, m2} {
		ws, _, err := dialWS(t, srv, id, c, testOrigin)
		if err != nil {
			t.Fatal(err)
		}
		defer ws.Close()
		conns = append(conns, ws)
	}
	time.Sleep(2 * time.Second) // let presence settle

	vote(t, srv, story, "3", fac)
	vote(t, srv, story, "5", m1)
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["revealed"] == true {
		t.Fatal("revealed with 2 of 3 votes")
	}

	// The third member disconnects; the shrunken denominator alone must NOT reveal.
	conns[2].Close()
	time.Sleep(2500 * time.Millisecond) // presence debounce + rebroadcast
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["revealed"] == true {
		t.Fatal("a disconnect triggered auto-reveal")
	}

	// The next vote event (an overwrite counts) satisfies votes >= connected.
	if resp := vote(t, srv, story, "8", m1); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("re-vote: %d", resp.StatusCode)
	}
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if env["revealed"] != true {
		t.Fatal("vote event did not auto-reveal once all connected members had voted")
	}

	// Overwrite was idempotent: still one vote per member, value updated.
	st := currentStory(env, story)
	votes := st["votes"].([]any)
	if len(votes) != 2 {
		t.Fatalf("votes after overwrite: %d", len(votes))
	}
	values := map[string]bool{}
	for _, v := range votes {
		values[v.(map[string]any)["value"].(string)] = true
	}
	if !values["8"] || values["5"] {
		t.Fatalf("overwrite did not replace the value: %v", values)
	}
}

func TestResetClearsVotes(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Reset Space")
	story := addStory(t, srv, id, "Reset story", fac)
	selectStory(t, srv, id, story, fac)
	vote(t, srv, story, "5", member)
	doJSON(t, srv, "POST", "/api/sessions/"+id+"/reveal", "", fac)

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/reset", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reset: %d", resp.StatusCode)
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", member)
	if env["revealed"] == true {
		t.Fatal("reset left revealed set")
	}
	st := currentStory(env, story)
	if len(st["votedUserIds"].([]any)) != 0 {
		t.Fatal("reset left votes behind")
	}
	// Re-vote works.
	if resp := vote(t, srv, story, "8", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("re-vote after reset: %d", resp.StatusCode)
	}
}

func TestEstimateSave(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Estimate Space")
	story := addStory(t, srv, id, "Estimated story", fac)

	if resp, _ := doJSON(t, srv, "PATCH", "/api/stories/"+story, `{"estimate":"5"}`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("estimate save: %d", resp.StatusCode)
	}
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	st := currentStory(env, story)
	if st["estimate"] != "5" || st["status"] != "estimated" {
		t.Fatalf("estimate not saved: %v %v", st["estimate"], st["status"])
	}
}

func TestDeckConfigRespected(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Deck Space", ada)
	slug := sp["slug"].(string)
	req, _ := http.NewRequest("POST", srv.URL+"/api/spaces/"+slug+"/sessions",
		strings.NewReader(`{"kind":"poker","title":"Shirts","config":{"deck":"tshirt"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(ada)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var sess map[string]any
	jsonDecode(t, resp, &sess)
	id := sess["id"].(string)

	story := addStory(t, srv, id, "Shirt story", ada)
	selectStory(t, srv, id, story, ada)
	if r := vote(t, srv, story, "5", ada); r.StatusCode != http.StatusConflict {
		t.Fatalf("numeric vote on tshirt deck: %d", r.StatusCode)
	}
	if r := vote(t, srv, story, "M", ada); r.StatusCode != http.StatusNoContent {
		t.Fatalf("tshirt vote: %d", r.StatusCode)
	}
	doJSON(t, srv, "POST", "/api/sessions/"+id+"/reveal", "", ada)
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", ada)
	res := currentStory(env, story)["results"].(map[string]any)
	if _, has := res["average"]; has {
		t.Fatal("ordinal deck reported an average")
	}
	if res["mode"] != "M" {
		t.Fatalf("mode: %v", res["mode"])
	}
}

func jsonDecode(t *testing.T, resp *http.Response, into any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
		t.Fatal(err)
	}
}

// A story either carries a ticket reference or is an ad-hoc round; both shapes
// have to survive the round trip, and an over-long ref has to be refused.
func TestStoryTicketRef(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Ref Space")

	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/stories",
		`{"title":"Rate limiting","ref":"PAR-142"}`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("add ticket story: %d", resp.StatusCode)
	}
	adHoc := addStory(t, srv, id, "Ad-hoc round", fac)

	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	stories := env["state"].(map[string]any)["stories"].([]any)
	if got := stories[0].(map[string]any)["ref"]; got != "PAR-142" {
		t.Fatalf("ticket ref round trip: %v", got)
	}
	if got := currentStory(env, adHoc)["ref"]; got != "" {
		t.Fatalf("ad-hoc story should have an empty ref, got %v", got)
	}

	// Attaching a ticket to an ad-hoc round afterwards.
	if resp, _ := doJSON(t, srv, "PATCH", "/api/stories/"+adHoc, `{"ref":"PAR-9"}`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("patch ref: %d", resp.StatusCode)
	}
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := currentStory(env, adHoc)["ref"]; got != "PAR-9" {
		t.Fatalf("patched ref: %v", got)
	}

	if resp, _ := doJSON(t, srv, "PATCH", "/api/stories/"+adHoc,
		`{"ref":"`+strings.Repeat("x", 41)+`"}`, fac); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("over-long ref: %d", resp.StatusCode)
	}
}
