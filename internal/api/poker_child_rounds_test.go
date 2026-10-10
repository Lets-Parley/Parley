package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func childRoundsFixture(t *testing.T) (*httptest.Server, *http.Cookie, string, string, string, string) {
	t.Helper()
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Child rounds")
	p := addStory(t, srv, id, "Parent", fac)
	a := draftChild(t, srv, id, p, "API", "api", 0, fac)
	b := draftChild(t, srv, id, p, "UI", "ui", 1, fac)
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": p, "expectedRevision": 0, "expectedSplitRevision": 2, "coverage": "full", "children": map[string]int{a: 0, b: 0}}, fac, 204)
	return srv, fac, id, p, a, b
}

func TestChildRoundReselectAndStaleActions(t *testing.T) {
	srv, fac, id, _, a, b := childRoundsFixture(t)
	selectStory(t, srv, id, a, fac)
	env := splitState(t, srv, id, fac)
	round := env["state"].(map[string]any)["roundVersion"].(float64)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": a, "value": "3", "expectedRoundVersion": round}, fac, 204)
	splitAction(t, srv, id, "reveal", map[string]any{"storyId": a, "expectedRoundVersion": round}, fac, 204)
	if s := currentStory(splitState(t, srv, id, fac), a); s["estimate"] != nil {
		t.Fatal("reveal accepted estimate")
	}
	selectStory(t, srv, id, b, fac)
	splitAction(t, srv, id, "select", map[string]any{"storyId": a}, fac, 409)
	before := splitState(t, srv, id, fac)["state"].(map[string]any)
	splitAction(t, srv, id, "select", map[string]any{"storyId": a, "freshRound": true, "expectedCurrentStoryId": b, "expectedRoundVersion": before["roundVersion"]}, fac, 204)
	env = splitState(t, srv, id, fac)
	if len(currentStory(env, a)["votedUserIds"].([]any)) != 0 {
		t.Fatal("fresh child round reused votes")
	}
	splitAction(t, srv, id, "vote", map[string]any{"storyId": a, "value": "5", "expectedRoundVersion": round}, fac, 409)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": a, "value": "5"}, fac, 409)
	splitAction(t, srv, id, "reveal", map[string]any{"storyId": b, "expectedRoundVersion": env["state"].(map[string]any)["roundVersion"]}, fac, 409)
	splitAction(t, srv, id, "reset", map[string]any{}, fac, 409)
	splitAction(t, srv, id, "select", map[string]any{"storyId": b, "switchToChildren": true, "expectedCurrentStoryId": a, "expectedRoundVersion": round}, fac, 409)
}

func TestChildAcceptanceAndScopeReview(t *testing.T) {
	srv, fac, id, _, a, b := childRoundsFixture(t)
	patch := func(story, fields string, want int) {
		t.Helper()
		resp := patchStory(t, srv, id, story, fields, fac)
		if resp.StatusCode != want {
			t.Fatalf("patch %s: %d want %d", fields, resp.StatusCode, want)
		}
	}
	patch(a, `"estimate":"3","expectedRevision":1,"acceptanceMode":"facilitator-set"`, 204)
	s := currentStory(splitState(t, srv, id, fac), a)
	if s["estimateProvenance"] != "facilitator-set" || s["estimateNeedsReview"] != false {
		t.Fatalf("direct provenance: %v", s)
	}
	selectStory(t, srv, id, a, fac)
	env := splitState(t, srv, id, fac)
	round := env["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "vote", map[string]any{"storyId": a, "value": "5", "expectedRoundVersion": round}, fac, 204)
	patch(a, `"title":"Larger API","expectedRevision":2`, 409)
	patch(a, fmt.Sprintf(`"title":"Larger API","expectedRevision":2,"scopeRestart":true,"expectedCurrentStoryId":%q,"expectedRoundVersion":%v`, a, round), 204)
	env = splitState(t, srv, id, fac)
	s = currentStory(env, a)
	if s["estimate"] != "3" || s["estimateNeedsReview"] != true || len(s["votedUserIds"].([]any)) != 0 {
		t.Fatalf("scope restart: %v", s)
	}
	patch(a, fmt.Sprintf(`"estimate":"5","expectedRevision":3,"acceptanceMode":"poker","expectedScopeRevision":1,"expectedRoundVersion":%v`, round), 409)
	round = env["state"].(map[string]any)["roundVersion"]
	patch(a, fmt.Sprintf(`"estimate":"5","expectedRevision":3,"acceptanceMode":"poker","expectedScopeRevision":1,"expectedRoundVersion":%v`, round), 409)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": a, "value": "5", "expectedRoundVersion": round}, fac, 204)
	splitAction(t, srv, id, "reveal", map[string]any{"storyId": a, "expectedRoundVersion": round}, fac, 204)
	patch(a, fmt.Sprintf(`"estimate":"5","expectedRevision":3,"acceptanceMode":"poker","expectedScopeRevision":0,"expectedRoundVersion":%v`, round), 409)
	patch(a, fmt.Sprintf(`"estimate":"5","expectedRevision":3,"acceptanceMode":"poker","expectedScopeRevision":1,"expectedRoundVersion":%v`, round), 204)
	s = currentStory(splitState(t, srv, id, fac), a)
	if s["estimateProvenance"] != "poker" || s["estimateNeedsReview"] != false {
		t.Fatalf("Poker acceptance: %v", s)
	}
	patch(a, fmt.Sprintf(`"estimate":"5","expectedRevision":3,"acceptanceMode":"poker","expectedScopeRevision":1,"expectedRoundVersion":%v`, round), 409)
	selectStory(t, srv, id, b, fac)
	patch(a, fmt.Sprintf(`"estimate":"8","expectedRevision":4,"acceptanceMode":"poker","expectedScopeRevision":1,"expectedRoundVersion":%v`, round), 409)
	patch(a, `"notes":"Additional scope","expectedRevision":4`, 204)
	s = currentStory(splitState(t, srv, id, fac), a)
	if s["estimate"] != "5" || s["estimateNeedsReview"] != true {
		t.Fatalf("accepted history lost: %v", s)
	}
	patch(a, `"estimate":"5","expectedRevision":5,"expectedScopeRevision":1,"acceptanceMode":"facilitator-set"`, 409)
	patch(a, `"estimate":"5","expectedRevision":5,"expectedScopeRevision":2,"acceptanceMode":"facilitator-set"`, 204)
	s = currentStory(splitState(t, srv, id, fac), a)
	if s["estimate"] != "5" || s["estimateNeedsReview"] != false || s["estimateProvenance"] != "facilitator-set" {
		t.Fatalf("reaffirmation: %v", s)
	}

}

func TestParentAdoptionRequiresRoundReview(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Parent review")
	p := addStory(t, srv, id, "Parent", fac)
	a := draftChild(t, srv, id, p, "API", "api", 0, fac)
	b := draftChild(t, srv, id, p, "UI", "ui", 1, fac)
	selectStory(t, srv, id, p, fac)
	env := splitState(t, srv, id, fac)
	round := env["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "vote", map[string]any{"storyId": p, "value": "13", "expectedRoundVersion": round}, fac, 204)
	adopt := map[string]any{"parentId": p, "expectedRevision": 0, "expectedSplitRevision": 2, "coverage": "full", "children": map[string]int{a: 0, b: 0}}
	splitAction(t, srv, id, "adopt", adopt, fac, 409)
	if env = splitState(t, srv, id, fac); env["state"].(map[string]any)["currentStoryId"] != p {
		t.Fatal("canceled adoption changed parent round")
	}
	splitAction(t, srv, id, "reveal", map[string]any{"storyId": p, "expectedRoundVersion": round}, fac, 204)
	splitAction(t, srv, id, "adopt", adopt, fac, 409)
	adopt["switchToChildren"] = true
	adopt["expectedRoundVersion"] = round
	adopt["expectedCurrentStoryId"] = p
	splitAction(t, srv, id, "adopt", adopt, fac, 204)
	env = splitState(t, srv, id, fac)
	if len(currentStory(env, p)["votedUserIds"].([]any)) != 1 || len(currentStory(env, a)["votedUserIds"].([]any)) != 0 {
		t.Fatal("adoption migrated votes")
	}
}

func TestChildScopeReviewSummaryAndCSV(t *testing.T) {
	srv, fac, id, _, a, _ := childRoundsFixture(t)
	if resp := patchStory(t, srv, id, a, `"estimate":"3","expectedRevision":1`, fac); resp.StatusCode != 204 {
		t.Fatal(resp.StatusCode)
	}
	if resp := patchStory(t, srv, id, a, `"notes":"Scope grew","expectedRevision":2`, fac); resp.StatusCode != 204 {
		t.Fatal(resp.StatusCode)
	}
	env := splitState(t, srv, id, fac)
	if s := currentStory(env, a); s["estimate"] != "3" || s["estimateNeedsReview"] != true {
		t.Fatalf("historical acceptance: %v", s)
	}
	progress := fieldJSON(t, spaceSessionRows(t, srv, spaceSlugOf(t, srv, id, fac), fac)[id], "progress")
	if progress != `{"kind":"poker","settled":0,"total":2}` {
		t.Fatalf("stale counted: %s", progress)
	}
	resp, body := fetchCSV(t, srv, id, fac)
	if resp.StatusCode != 200 || !strings.Contains(body, "needs-review") || !strings.Contains(body, "facilitator-set") {
		t.Fatalf("CSV hides review/provenance: %s", body)
	}
}

func TestChildPokerAcceptanceRequiresARevealedVote(t *testing.T) {
	srv, fac, id, _, a, _ := childRoundsFixture(t)
	selectStory(t, srv, id, a, fac)
	env := splitState(t, srv, id, fac)
	round := env["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "reveal", map[string]any{"storyId": a, "expectedRoundVersion": round}, fac, 204)
	if resp := patchStory(t, srv, id, a, fmt.Sprintf(`"estimate":"3","expectedRevision":1,"acceptanceMode":"poker","expectedScopeRevision":0,"expectedRoundVersion":%v`, round), fac); resp.StatusCode != 409 {
		t.Fatalf("empty round claimed Poker: %d", resp.StatusCode)
	}
}

func TestChildAcceptancePreservesDeckAndAuthority(t *testing.T) {
	srv, fac, id, p, a, b := childRoundsFixture(t)
	_, env := doJSON(t, srv, http.MethodGet, "/api/sessions/"+id, "", fac)
	for _, value := range []string{"?", "coffee", "4", "7", "M"} {
		resp := patchStory(t, srv, id, a, fmt.Sprintf(`"estimate":%q,"expectedRevision":1,"acceptanceMode":"facilitator-set"`, value), fac)
		if resp.StatusCode != 400 {
			t.Fatalf("invalid deck acceptance %q: %d", value, resp.StatusCode)
		}
	}
	if currentStory(env, p)["estimate"] != nil || currentStory(env, b)["estimate"] != nil {
		t.Fatal("direct refusal changed sibling or parent")
	}
	splitAction(t, srv, id, "select", map[string]any{"storyId": a}, fac, 204)
	env = splitState(t, srv, id, fac)
	round := env["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "vote", map[string]any{"storyId": a, "value": "3", "expectedRoundVersion": round}, fac, 204)
	env = splitState(t, srv, id, fac)
	if _, present := currentStory(env, a)["votes"]; present {
		t.Fatal("hidden votes disclosed in child state")
	}
	splitAction(t, srv, id, "vote", map[string]any{"storyId": b, "value": "5", "expectedRoundVersion": round}, fac, 409)
}

func TestChildConcurrentAcceptanceKeepsOneRevision(t *testing.T) {
	srv, fac, id, _, a, b := childRoundsFixture(t)
	statuses := concurrentStatuses(t, 2, func(i int) (int, error) {
		resp, _ := doJSON(t, srv, http.MethodPatch, "/api/sessions/"+id+"/actions/story", fmt.Sprintf(`{"storyId":%q,"estimate":%q,"acceptanceMode":"facilitator-set","expectedRevision":1,"expectedScopeRevision":0}`, a, []string{"3", "5"}[i]), fac)
		resp.Body.Close()
		return resp.StatusCode, nil
	})
	if !((statuses[0] == 204 && statuses[1] == 409) || (statuses[0] == 409 && statuses[1] == 204)) {
		t.Fatalf("concurrent acceptance: %v", statuses)
	}
	env := splitState(t, srv, id, fac)
	if s := currentStory(env, a); s["contentRevision"] != float64(2) || s["estimateProvenance"] != "facilitator-set" {
		t.Fatalf("decision revision: %v", s)
	}
	if currentStory(env, b)["estimate"] != nil {
		t.Fatal("acceptance changed sibling")
	}
}
