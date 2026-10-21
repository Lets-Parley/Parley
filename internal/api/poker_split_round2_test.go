package api

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type draftedSplit struct {
	srv                 *httptest.Server
	facilitator, member *http.Cookie
	sessionID, parentID string
	first, second       string
}

func draftSplit(t *testing.T, name string) draftedSplit {
	t.Helper()
	srv := testServer(t)
	facilitator, member, sessionID := setupSession(t, srv, name)
	split := draftedSplit{srv: srv, facilitator: facilitator, member: member, sessionID: sessionID}
	split.parentID = addStory(t, srv, sessionID, "Parent", facilitator)
	split.first = draftChild(t, srv, sessionID, split.parentID, "One", "one", 0, facilitator)
	split.second = draftChild(t, srv, sessionID, split.parentID, "Two", "two", 1, facilitator)
	return split
}

func (split draftedSplit) story(t *testing.T, storyID string) map[string]any {
	t.Helper()
	return currentStory(splitState(t, split.srv, split.sessionID, split.member), storyID)
}

func (split draftedSplit) activeChildRevisions(t *testing.T) map[string]any {
	t.Helper()
	revisions := map[string]any{}
	for _, raw := range splitState(t, split.srv, split.sessionID, split.facilitator)["state"].(map[string]any)["stories"].([]any) {
		story := raw.(map[string]any)
		if story["parentId"] == split.parentID && story["removedAt"] == nil {
			revisions[story["id"].(string)] = story["contentRevision"]
		}
	}
	return revisions
}

func (split draftedSplit) adoptionBody(t *testing.T) map[string]any {
	t.Helper()
	env := splitState(t, split.srv, split.sessionID, split.facilitator)
	parent := currentStory(env, split.parentID)
	state := env["state"].(map[string]any)
	current, _ := state["currentStoryId"].(string)
	return map[string]any{"parentId": split.parentID, "expectedRevision": parent["contentRevision"], "expectedSplitRevision": parent["splitRevision"], "coverage": "full",
		"children": split.activeChildRevisions(t), "switchToChildren": true, "expectedCurrentStoryId": current, "expectedRoundVersion": state["roundVersion"]}
}

func (split draftedSplit) undoBody(t *testing.T) map[string]any {
	t.Helper()
	return undoRequest(t, split.srv, split.sessionID, split.parentID, split.facilitator)
}

func (split draftedSplit) act(t *testing.T, action string, body map[string]any, want int) map[string]any {
	t.Helper()
	return splitAction(t, split.srv, split.sessionID, action, body, split.facilitator, want)
}

func TestEstimateOverrideDiscardsTheHiddenRound(t *testing.T) {
	srv := testServer(t)
	facilitator, member, sessionID := setupSession(t, srv, "Override discards")
	story := addStory(t, srv, sessionID, "Flat", facilitator)
	selectStory(t, srv, sessionID, story, facilitator)
	if resp := vote(t, srv, sessionID, story, "5", member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote: %d", resp.StatusCode)
	}
	state := splitState(t, srv, sessionID, facilitator)["state"].(map[string]any)
	if resp := patchStory(t, srv, sessionID, story, fmt.Sprintf(`"estimate":"8","endRound":true,"expectedCurrentStoryId":%q,"expectedRoundVersion":%v`, story, state["roundVersion"]), facilitator); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("override: %d", resp.StatusCode)
	}
	if overridden := currentStory(splitState(t, srv, sessionID, member), story); len(overridden["votedUserIds"].([]any)) != 0 || overridden["estimate"] != "8" {
		t.Fatalf("the overridden round kept its hidden votes: %v", overridden)
	}
	selectStory(t, srv, sessionID, story, facilitator)
	if resp, _ := doJSON(t, srv, http.MethodPost, "/api/sessions/"+sessionID+"/actions/reveal", "", facilitator); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reveal: %d", resp.StatusCode)
	}
	env := splitState(t, srv, sessionID, member)
	if revealed := currentStory(env, story); env["revealed"] != true || revealed["votes"] != nil {
		t.Fatalf("a later reveal showed a vote from the overridden round: %v", revealed)
	}
	if _, exported := fetchCSV(t, srv, sessionID, member); strings.Contains(exported, "Mel: 5") {
		t.Fatal("the export shows a vote from the overridden round")
	}
}

func TestPokerUndoSplitKeepsTheVotesBehindAnAcceptedParentEstimate(t *testing.T) {
	split := draftSplit(t, "Undo keeps accepted votes")
	srv, facilitator, sessionID := split.srv, split.facilitator, split.sessionID
	selectStory(t, srv, sessionID, split.parentID, facilitator)
	round := splitState(t, srv, sessionID, facilitator)["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, sessionID, "vote", map[string]any{"storyId": split.parentID, "value": "13", "expectedRoundVersion": round}, split.member, http.StatusNoContent)
	splitAction(t, srv, sessionID, "reveal", map[string]any{"storyId": split.parentID, "expectedRoundVersion": round}, facilitator, http.StatusNoContent)
	if resp := patchStory(t, srv, sessionID, split.parentID, fmt.Sprintf(`"estimate":"13","expectedRevision":0,"acceptanceMode":"poker","expectedScopeRevision":0,"expectedRoundVersion":%v`, round), facilitator); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("accept: %d", resp.StatusCode)
	}
	parentRow := func() []string {
		t.Helper()
		_, body := fetchCSV(t, srv, sessionID, split.member)
		rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range rows[1:] {
			if row[6] == split.parentID {
				return row
			}
		}
		t.Fatal("parent is not in the export")
		return nil
	}
	before := parentRow()
	if before[3] != "13" || before[4] != "1" || !strings.Contains(before[5], "Mel: 13") {
		t.Fatalf("fixture export does not carry the accepted round: %v", before)
	}
	split.act(t, "adopt", split.adoptionBody(t), http.StatusNoContent)
	split.act(t, "undo-split", split.undoBody(t), http.StatusNoContent)
	parent := split.story(t, split.parentID)
	if parent["estimate"] != "13" || parent["estimateProvenance"] != "poker" || len(parent["votedUserIds"].([]any)) != 1 {
		t.Fatalf("undo dropped the votes behind an accepted Poker estimate: %v", parent)
	}
	if after := parentRow(); after[3] != "13" || after[4] != before[4] || after[15] != "poker" {
		t.Fatalf("export lost the votes behind the accepted estimate: %v", after)
	}
}

func TestPokerUndoSplitRefusesStaleChildren(t *testing.T) {
	split := draftSplit(t, "Undo stale children")
	split.act(t, "adopt", split.adoptionBody(t), http.StatusNoContent)
	captured := split.undoBody(t)
	withoutChildren := split.undoBody(t)
	delete(withoutChildren, "children")
	split.act(t, "undo-split", withoutChildren, http.StatusConflict)
	if resp := patchStory(t, split.srv, split.sessionID, split.first, `"title":"Retitled","estimate":"3","expectedRevision":1`, split.facilitator); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("edit child: %d", resp.StatusCode)
	}
	if out := split.act(t, "undo-split", captured, http.StatusConflict); out["error"] != "story or split changed; review latest and your input before saving" {
		t.Fatalf("a replayed undo over a changed child: %v", out)
	}
	if split.story(t, split.parentID)["planningRole"] != "context" {
		t.Fatal("a stale undo changed the split")
	}
	split.act(t, "undo-split", split.undoBody(t), http.StatusNoContent)
}

func TestPokerLeftoverDraftIsRecordedForEveryone(t *testing.T) {
	split := draftSplit(t, "Leftover draft")
	revision := func() any { return split.story(t, split.parentID)["splitRevision"] }
	split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": split.second, "expectedSplitRevision": 0}, http.StatusConflict)
	splitAction(t, split.srv, split.sessionID, "leftover", map[string]any{"parentId": split.parentID, "storyId": split.second, "expectedSplitRevision": revision()}, split.member, http.StatusForbidden)
	split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": split.parentID, "expectedSplitRevision": revision()}, http.StatusConflict)
	split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": split.second}, http.StatusBadRequest)
	if split.story(t, split.second)["isRemainder"] != false {
		t.Fatal("a refused request named a leftover")
	}
	before := revision().(float64)
	split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": split.second, "expectedSplitRevision": before}, http.StatusNoContent)
	if split.story(t, split.second)["isRemainder"] != true || split.story(t, split.first)["isRemainder"] != false || revision() != before+1 {
		t.Fatalf("leftover was not recorded on one draft for everyone: %v", split.story(t, split.second))
	}
	split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": split.first, "expectedSplitRevision": revision()}, http.StatusNoContent)
	if split.story(t, split.second)["isRemainder"] != false || split.story(t, split.first)["isRemainder"] != true {
		t.Fatal("naming another draft left two leftovers")
	}

	full := split.adoptionBody(t)
	split.act(t, "adopt", full, http.StatusConflict)
	full["coverage"] = "remainder"
	full["remainderId"] = split.second
	split.act(t, "adopt", full, http.StatusConflict)
	if split.story(t, split.parentID)["planningRole"] != "planning" {
		t.Fatal("a split was committed against its named leftover")
	}

	split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": "", "expectedSplitRevision": revision()}, http.StatusNoContent)
	if split.story(t, split.first)["isRemainder"] != false {
		t.Fatal("clearing left the flag")
	}
	split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": split.first, "expectedSplitRevision": revision()}, http.StatusNoContent)
	third := split.act(t, "child", map[string]any{"parentId": split.parentID, "title": "Three", "operationId": "three", "expectedSplitRevision": revision()}, http.StatusCreated)["storyId"].(string)
	split.act(t, "remove-child", map[string]any{"storyId": split.first, "expectedRevision": split.story(t, split.first)["contentRevision"], "expectedSplitRevision": revision()}, http.StatusNoContent)
	if split.story(t, split.first)["isRemainder"] != false {
		t.Fatal("a discarded draft is still the leftover")
	}
	split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": third, "expectedSplitRevision": revision()}, http.StatusNoContent)
	remainder := split.adoptionBody(t)
	remainder["coverage"] = "remainder"
	remainder["remainderId"] = third
	split.act(t, "adopt", remainder, http.StatusNoContent)
	if split.story(t, third)["isRemainder"] != true || split.story(t, split.parentID)["coverage"] != "remainder" {
		t.Fatal("the named leftover was not committed as the remainder")
	}
	fourth := split.act(t, "child", map[string]any{"parentId": split.parentID, "title": "Four", "operationId": "four", "expectedSplitRevision": revision()}, http.StatusCreated)["storyId"].(string)
	if out := split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": fourth, "expectedSplitRevision": revision()}, http.StatusConflict); out["error"] != "this split already has a leftover story" {
		t.Fatalf("a second leftover beside a committed one: %v", out)
	}
}

func TestPokerParkedFlagMeansThereAreDraftsSetAside(t *testing.T) {
	split := draftSplit(t, "Parked meaning")
	flat := addStory(t, split.srv, split.sessionID, "Flat", split.facilitator)
	if out := split.act(t, "park-drafts", map[string]any{"parentId": flat, "parked": true}, http.StatusConflict); out["error"] != "this story has no draft stories to set aside" {
		t.Fatalf("parking a story with no drafts: %v", out)
	}
	split.act(t, "park-drafts", map[string]any{"parentId": flat, "parked": false}, http.StatusNoContent)
	split.act(t, "park-drafts", map[string]any{"parentId": split.parentID, "parked": true}, http.StatusNoContent)
	revision := func() any { return split.story(t, split.parentID)["splitRevision"] }
	split.act(t, "remove-child", map[string]any{"storyId": split.first, "expectedRevision": 0, "expectedSplitRevision": revision()}, http.StatusNoContent)
	if split.story(t, split.parentID)["draftsParked"] != true {
		t.Fatal("discarding one of two drafts unparked the other")
	}
	split.act(t, "remove-child", map[string]any{"storyId": split.second, "expectedRevision": 0, "expectedSplitRevision": revision()}, http.StatusNoContent)
	if split.story(t, split.parentID)["draftsParked"] != false {
		t.Fatal("a story with no drafts left is still recorded as having drafts set aside")
	}
	split.act(t, "park-drafts", map[string]any{"parentId": split.parentID, "parked": true}, http.StatusConflict)
	split.act(t, "restore-child", map[string]any{"storyId": split.second, "expectedRevision": 1, "expectedSplitRevision": revision()}, http.StatusNoContent)
	split.act(t, "remove-child", map[string]any{"storyId": split.parentID, "expectedRevision": 0, "expectedSplitRevision": 0}, http.StatusConflict)
}

func TestChildCapRefusalIsTrueWhenRemovedCommittedStoriesBlock(t *testing.T) {
	split := draftSplit(t, "Cap wording")
	revision := func() any { return split.story(t, split.parentID)["splitRevision"] }
	for index := 0; index < 8; index++ {
		split.act(t, "child", map[string]any{"parentId": split.parentID, "title": fmt.Sprintf("More %d", index), "operationId": fmt.Sprintf("more-%d", index), "expectedSplitRevision": revision()}, http.StatusCreated)
	}
	split.act(t, "adopt", split.adoptionBody(t), http.StatusNoContent)
	split.act(t, "remove-child", map[string]any{"storyId": split.first, "expectedRevision": 1, "expectedSplitRevision": revision()}, http.StatusNoContent)
	out := split.act(t, "child", map[string]any{"parentId": split.parentID, "title": "Eleventh", "operationId": "eleventh", "expectedSplitRevision": revision()}, http.StatusConflict)
	if out["error"] != "a split can hold at most 10 stories; removed stories that were committed still count, discarded drafts do not" {
		t.Fatalf("cap refusal: %v", out)
	}
}
