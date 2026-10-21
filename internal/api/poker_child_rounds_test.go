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
	splitAction(t, srv, id, "select", map[string]any{"storyId": a, "expectedCurrentStoryId": b, "expectedRoundVersion": before["roundVersion"]}, fac, 409)
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
	for _, value := range []string{"?", "coffee", "4", "7", "M"} {
		resp := patchStory(t, srv, id, a, fmt.Sprintf(`"estimate":%q,"expectedRevision":1,"acceptanceMode":"facilitator-set"`, value), fac)
		if resp.StatusCode != 400 {
			t.Fatalf("invalid deck acceptance %q: %d", value, resp.StatusCode)
		}
	}
	env := splitState(t, srv, id, fac)
	if currentStory(env, p)["estimate"] != nil || currentStory(env, b)["estimate"] != nil || currentStory(env, a)["estimate"] != nil || currentStory(env, a)["contentRevision"] != float64(1) {
		t.Fatal("direct refusal changed the story, a sibling or the parent")
	}
	selectStory(t, srv, id, a, fac)
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

func TestChildSelectionRequiresReviewedSnapshot(t *testing.T) {
	srv, fac, id, _, a, b := childRoundsFixture(t)
	state := splitState(t, srv, id, fac)["state"].(map[string]any)
	round := state["roundVersion"]
	for _, fields := range []map[string]any{
		{}, {"expectedCurrentStoryId": ""}, {"expectedRoundVersion": round},
		{"expectedCurrentStoryId": "", "expectedRoundVersion": -1},
		{"expectedCurrentStoryId": a, "expectedRoundVersion": round},
	} {
		fields["storyId"] = a
		splitAction(t, srv, id, "select", fields, fac, 409)
	}
	splitAction(t, srv, id, "select", map[string]any{"storyId": a, "expectedCurrentStoryId": "", "expectedRoundVersion": round}, fac, 204)
	state = splitState(t, srv, id, fac)["state"].(map[string]any)
	round = state["roundVersion"]
	splitAction(t, srv, id, "vote", map[string]any{"storyId": a, "value": "3", "expectedRoundVersion": round}, fac, 204)
	flat := addStory(t, srv, id, "Flat", fac)
	for _, target := range []string{b, flat} {
		splitAction(t, srv, id, "select", map[string]any{"storyId": target}, fac, 409)
		splitAction(t, srv, id, "select", map[string]any{"storyId": target, "expectedCurrentStoryId": "", "expectedRoundVersion": round}, fac, 409)
	}
	if state = splitState(t, srv, id, fac)["state"].(map[string]any); state["currentStoryId"] != a || state["roundVersion"] != round {
		t.Fatalf("refused selection changed round: %v", state)
	}
	statuses := concurrentStatuses(t, 2, func(i int) (int, error) {
		return requestStatus(srv, http.MethodPost, "/api/sessions/"+id+"/actions/select", fmt.Sprintf(`{"storyId":%q,"expectedCurrentStoryId":%q,"expectedRoundVersion":%v}`, []string{b, flat}[i], a, round), fac)
	})
	requireStatuses(t, statuses, 204, 409, 1)
}

func TestEmbeddedSplitVotesCarryRoundVersion(t *testing.T) {
	srv := embedServer(t, testPool(t))
	fac, _, id := setupSession(t, srv, "Embedded child rounds")
	token := embedToken(t, srv, fac)
	p := addStory(t, srv, id, "Parent", fac)
	a := draftChild(t, srv, id, p, "API", "api", 0, fac)
	b := draftChild(t, srv, id, p, "UI", "ui", 1, fac)
	selectStory(t, srv, id, p, fac)
	vote := func(story string) {
		t.Helper()
		round := splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"]
		path := "/api/sessions/" + id + "/actions/vote"
		for _, body := range []string{fmt.Sprintf(`{"storyId":%q,"value":"3"}`, story), fmt.Sprintf(`{"storyId":%q,"value":"3","expectedRoundVersion":-1}`, story)} {
			if got := bearerStatus(t, srv, "POST", path, body, token); got != 409 {
				t.Fatalf("unguarded embedded vote=%d", got)
			}
		}
		if got := bearerStatus(t, srv, "POST", path, fmt.Sprintf(`{"storyId":%q,"value":"3","expectedRoundVersion":%v}`, story, round), token); got != 204 {
			t.Fatalf("reviewed embedded vote=%d", got)
		}
	}
	vote(p)
	round := splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": p, "expectedRevision": 0, "expectedSplitRevision": 2, "coverage": "full", "children": map[string]int{a: 0, b: 0}, "switchToChildren": true, "expectedCurrentStoryId": p, "expectedRoundVersion": round}, fac, 204)
	selectStory(t, srv, id, a, fac)
	vote(a)
}

func TestRemovingTheChildOnTheTableRequiresRoundReview(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Remove on the table")
	parentID := addStory(t, srv, id, "Parent", fac)
	apiStory := draftChild(t, srv, id, parentID, "API", "api", 0, fac)
	uiStory := draftChild(t, srv, id, parentID, "UI", "ui", 1, fac)
	docsStory := draftChild(t, srv, id, parentID, "Docs", "docs", 2, fac)
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": parentID, "expectedRevision": 0, "expectedSplitRevision": 3, "coverage": "full", "children": map[string]int{apiStory: 0, uiStory: 0, docsStory: 0}}, fac, 204)
	selectStory(t, srv, id, docsStory, fac)
	round := splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"].(float64)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": docsStory, "value": "5", "expectedRoundVersion": round}, member, 204)

	removal := map[string]any{"storyId": docsStory, "expectedRevision": 1, "expectedSplitRevision": 4}
	out := splitAction(t, srv, id, "remove-child", removal, fac, 409)
	if out["error"] != "review this round before switching, restarting or saving" {
		t.Fatalf("a live round was ended without review: %v", out)
	}
	removal["endRound"] = true
	splitAction(t, srv, id, "remove-child", removal, fac, 409)
	removal["expectedCurrentStoryId"] = docsStory
	removal["expectedRoundVersion"] = round - 1
	splitAction(t, srv, id, "remove-child", removal, fac, 409)
	removal["expectedCurrentStoryId"] = apiStory
	removal["expectedRoundVersion"] = round
	splitAction(t, srv, id, "remove-child", removal, fac, 409)
	env := splitState(t, srv, id, fac)
	if env["state"].(map[string]any)["currentStoryId"] != docsStory || env["state"].(map[string]any)["roundVersion"] != round || currentStory(env, docsStory)["removedAt"] != nil || currentStory(env, parentID)["coverage"] != "full" {
		t.Fatalf("a refused removal changed the room: %v", env["state"])
	}

	removal["expectedCurrentStoryId"] = docsStory
	splitAction(t, srv, id, "remove-child", removal, fac, 204)
	env = splitState(t, srv, id, member)
	state := env["state"].(map[string]any)
	if state["currentStoryId"] != nil || env["revealed"] != false || state["roundVersion"] != round+1 {
		t.Fatalf("reviewed removal did not end the round: %v", state)
	}
	if removed := currentStory(env, docsStory); removed["removedAt"] == nil || len(removed["votedUserIds"].([]any)) != 1 || removed["votes"] != nil {
		t.Fatalf("removal dropped or revealed votes: %v", removed)
	}
}

func TestRemovingAChildOffTheTableNeedsNoRoundReview(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Remove beside the table")
	parentID := addStory(t, srv, id, "Parent", fac)
	apiStory := draftChild(t, srv, id, parentID, "API", "api", 0, fac)
	uiStory := draftChild(t, srv, id, parentID, "UI", "ui", 1, fac)
	docsStory := draftChild(t, srv, id, parentID, "Docs", "docs", 2, fac)
	opsStory := draftChild(t, srv, id, parentID, "Ops", "ops", 3, fac)
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": parentID, "expectedRevision": 0, "expectedSplitRevision": 4, "coverage": "full", "children": map[string]int{apiStory: 0, uiStory: 0, docsStory: 0, opsStory: 0}}, fac, 204)
	selectStory(t, srv, id, apiStory, fac)
	round := splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"].(float64)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": apiStory, "value": "5", "expectedRoundVersion": round}, member, 204)
	splitAction(t, srv, id, "remove-child", map[string]any{"storyId": docsStory, "expectedRevision": 1, "expectedSplitRevision": 5}, fac, 204)
	state := splitState(t, srv, id, fac)["state"].(map[string]any)
	if state["currentStoryId"] != apiStory || state["roundVersion"] != round {
		t.Fatalf("removing another child disturbed the round: %v", state)
	}

	splitAction(t, srv, id, "reveal", map[string]any{"storyId": apiStory, "expectedRoundVersion": round}, fac, 204)
	if resp := patchStory(t, srv, id, apiStory, fmt.Sprintf(`"estimate":"5","expectedRevision":1,"acceptanceMode":"poker","expectedScopeRevision":0,"expectedRoundVersion":%v`, round), fac); resp.StatusCode != 204 {
		t.Fatalf("accept: %d", resp.StatusCode)
	}
	splitAction(t, srv, id, "remove-child", map[string]any{"storyId": apiStory, "expectedRevision": 2, "expectedSplitRevision": 6}, fac, 204)
	if state = splitState(t, srv, id, fac)["state"].(map[string]any); state["currentStoryId"] != nil {
		t.Fatalf("removing a settled child left it on the table: %v", state)
	}
}

func TestSettingAnEstimateOnTheLiveRoundEndsItOnlyAfterReview(t *testing.T) {
	srv, fac, id, _, apiStory, uiStory := childRoundsFixture(t)
	selectStory(t, srv, id, apiStory, fac)
	round := splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"].(float64)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": apiStory, "value": "5", "expectedRoundVersion": round}, fac, 204)
	patch := func(story, fields string, want int) {
		t.Helper()
		if resp := patchStory(t, srv, id, story, fields, fac); resp.StatusCode != want {
			t.Fatalf("patch %s: %d want %d", fields, resp.StatusCode, want)
		}
	}
	patch(apiStory, `"estimate":"3","expectedRevision":1,"acceptanceMode":"facilitator-set"`, 409)
	patch(apiStory, `"estimate":"3","expectedRevision":1`, 409)
	patch(apiStory, fmt.Sprintf(`"estimate":"3","expectedRevision":1,"endRound":true,"expectedCurrentStoryId":%q,"expectedRoundVersion":%v`, apiStory, round-1), 409)
	patch(apiStory, fmt.Sprintf(`"estimate":"3","expectedRevision":1,"endRound":true,"expectedCurrentStoryId":%q,"expectedRoundVersion":%v`, uiStory, round), 409)
	patch(apiStory, fmt.Sprintf(`"estimate":"3","expectedRevision":1,"expectedCurrentStoryId":%q,"expectedRoundVersion":%v`, apiStory, round), 409)
	env := splitState(t, srv, id, fac)
	if story := currentStory(env, apiStory); story["estimate"] != nil || story["contentRevision"] != float64(1) || env["state"].(map[string]any)["currentStoryId"] != apiStory || env["state"].(map[string]any)["roundVersion"] != round {
		t.Fatalf("a refused estimate changed the story or its round: %v", story)
	}

	patch(apiStory, fmt.Sprintf(`"estimate":"3","expectedRevision":1,"endRound":true,"expectedCurrentStoryId":%q,"expectedRoundVersion":%v`, apiStory, round), 204)
	env = splitState(t, srv, id, fac)
	state := env["state"].(map[string]any)
	if state["currentStoryId"] != nil || env["revealed"] != false || state["roundVersion"] != round+1 {
		t.Fatalf("the estimate did not end the round: %v", state)
	}
	if story := currentStory(env, apiStory); story["estimate"] != "3" || story["estimateProvenance"] != "facilitator-set" || len(story["votedUserIds"].([]any)) != 0 || story["votes"] != nil {
		t.Fatalf("estimate, provenance or discarded votes: %v", story)
	}
	splitAction(t, srv, id, "vote", map[string]any{"storyId": apiStory, "value": "8", "expectedRoundVersion": round}, fac, 409)

	patch(uiStory, `"estimate":"5","expectedRevision":1`, 204)
	patch(uiStory, `"estimate":"","expectedRevision":2`, 204)
	selectStory(t, srv, id, uiStory, fac)
	round = splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"].(float64)
	patch(uiStory, `"estimate":"","expectedRevision":3`, 204)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": uiStory, "value": "5", "expectedRoundVersion": round}, fac, 204)
	splitAction(t, srv, id, "reveal", map[string]any{"storyId": uiStory, "expectedRoundVersion": round}, fac, 204)
	patch(uiStory, `"estimate":"8","expectedRevision":4,"acceptanceMode":"facilitator-set"`, 204)
	env = splitState(t, srv, id, fac)
	if state = env["state"].(map[string]any); state["currentStoryId"] != uiStory || env["revealed"] != true || state["roundVersion"] != round {
		t.Fatalf("an estimate on a revealed round disturbed it: %v", state)
	}
}

func TestSettingAnEstimateOnAFlatLiveRoundEndsItOnlyAfterReview(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Flat override")
	story := addStory(t, srv, id, "Flat", fac)
	selectStory(t, srv, id, story, fac)
	if resp := vote(t, srv, id, story, "5", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote: %d", resp.StatusCode)
	}
	if resp := patchStory(t, srv, id, story, `"estimate":"8"`, fac); resp.StatusCode != http.StatusConflict {
		t.Fatalf("estimate over a live flat round: %d", resp.StatusCode)
	}
	state := splitState(t, srv, id, fac)["state"].(map[string]any)
	if resp := patchStory(t, srv, id, story, fmt.Sprintf(`"estimate":"8","endRound":true,"expectedCurrentStoryId":%q,"expectedRoundVersion":%v`, story, state["roundVersion"]), fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reviewed estimate: %d", resp.StatusCode)
	}
	env := splitState(t, srv, id, member)
	if overridden := currentStory(env, story); env["state"].(map[string]any)["currentStoryId"] != nil || overridden["estimate"] != "8" || len(overridden["votedUserIds"].([]any)) != 0 || overridden["votes"] != nil {
		t.Fatalf("flat override: %v", overridden)
	}
}
