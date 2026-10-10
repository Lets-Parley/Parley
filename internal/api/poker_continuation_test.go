package api

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestLeaveUnestimatedKeepsScopeAndVotes(t *testing.T) {
	srv, fac, id, _, a, b := childRoundsFixture(t)
	selectStory(t, srv, id, a, fac)
	before := splitState(t, srv, id, fac)
	round := before["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "vote", map[string]any{"storyId": a, "value": "5", "expectedRoundVersion": round}, fac, 204)
	splitAction(t, srv, id, "reveal", map[string]any{"storyId": a, "expectedRoundVersion": round}, fac, 204)
	before = splitState(t, srv, id, fac)
	body := map[string]any{"storyId": a, "leaveUnestimated": true, "expectedCurrentStoryId": a, "expectedRoundVersion": round}
	body["storyId"] = b
	splitAction(t, srv, id, "select", body, fac, http.StatusConflict)
	body["storyId"] = a
	splitAction(t, srv, id, "select", body, fac, http.StatusNoContent)
	after := splitState(t, srv, id, fac)
	if after["state"].(map[string]any)["currentStoryId"] != nil || after["revealed"] != true {
		t.Fatalf("leave changed reveal or kept selection: %v", after)
	}
	old, fresh := currentStory(before, a), currentStory(after, a)
	delete(old, "votes")
	delete(old, "results")
	delete(fresh, "votes")
	delete(fresh, "results")
	if !reflect.DeepEqual(old, fresh) {
		t.Fatal("leave changed scope, estimate or votes")
	}
	splitAction(t, srv, id, "select", body, fac, http.StatusConflict)
	selectStory(t, srv, id, b, fac)
	body["storyId"] = b
	body["expectedCurrentStoryId"] = b
	body["expectedRoundVersion"] = splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"]
	delete(body, "expectedRoundVersion")
	splitAction(t, srv, id, "select", body, fac, http.StatusConflict)
	if resp := patchStory(t, srv, id, b, `"estimate":"3","expectedRevision":1,"expectedScopeRevision":0,"acceptanceMode":"facilitator-set"`, fac); resp.StatusCode != 204 {
		t.Fatal(resp.StatusCode)
	}
	selectStory(t, srv, id, b, fac)
	body["expectedRoundVersion"] = splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "select", body, fac, http.StatusConflict)
}

func TestSplitContinuationCloseReopenExport(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, id := setupSession(t, srv, "Continuation")
	p := addStory(t, srv, id, "=Original", fac)
	if resp := patchStory(t, srv, id, p, `"estimate":"13","notes":"=private note"`, fac); resp.StatusCode != 204 {
		t.Fatal(resp.StatusCode)
	}
	a := draftChild(t, srv, id, p, "API", "a", 0, fac)
	b := draftChild(t, srv, id, p, "UI", "b", 1, fac)
	c := draftChild(t, srv, id, p, "Permissions", "c", 2, fac)
	patchStory(t, srv, id, a, `"estimate":"3","expectedRevision":0`, fac)
	patchStory(t, srv, id, b, `"estimate":"5","expectedRevision":0`, fac)
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": p, "expectedRevision": 1, "expectedSplitRevision": 3, "coverage": "full", "children": map[string]int{a: 1, b: 1, c: 0}}, fac, 204)
	splitAction(t, srv, id, "dependencies", map[string]any{"parentId": p, "expectedRevision": 2, "expectedDependencyRevision": 0, "children": map[string]int{a: 2, b: 2, c: 1}, "edges": []map[string]string{{"blockerId": a, "dependentId": c}, {"blockerId": b, "dependentId": c}}}, fac, 204)
	selectStory(t, srv, id, c, fac)
	env := splitState(t, srv, id, member)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": c, "value": "13", "expectedRoundVersion": env["state"].(map[string]any)["roundVersion"]}, member, 204)
	before := splitState(t, srv, id, member)["state"].(map[string]any)
	resp, csvBefore := fetchCSV(t, srv, id, member)
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	if strings.Contains(csvBefore, "Mel: 13") || !strings.Contains(csvBefore, "'=private note") {
		t.Fatal("CSV leaked hidden values or lost safe notes")
	}
	if resp, _ := doJSON(t, srv, "DELETE", "/api/sessions/"+id, "", fac); resp.StatusCode != 204 {
		t.Fatal(resp.StatusCode)
	}
	_, csvAfter := fetchCSV(t, srv, id, member)
	if csvAfter != csvBefore {
		t.Fatal("close changed CSV identities, dependencies or values")
	}
	if resp, _ := doJSON(t, srv, "POST", "/api/sessions/"+id+"/reopen", "", fac); resp.StatusCode != 204 {
		t.Fatal(resp.StatusCode)
	}
	after := splitState(t, srv, id, member)["state"].(map[string]any)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("close/reopen changed retained planning state")
	}
	progress := fieldJSON(t, spaceSessionRows(t, srv, spaceSlugOf(t, srv, id, fac), fac)[id], "progress")
	if progress != `{"kind":"poker","settled":2,"total":3}` {
		t.Fatalf("progress=%s", progress)
	}
	outsider := signup(t, srv, "Outside")
	if resp, _ := fetchCSV(t, srv, id, outsider); resp.StatusCode != http.StatusNotFound {
		t.Fatal("outsider obtained split export")
	}
}
