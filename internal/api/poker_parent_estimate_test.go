package api

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/poker/publication"
)

type estimatedSplit struct {
	draftedSplit
	children []string
}

func commitSplitOnDeck(t *testing.T, name, deck string, titles ...string) estimatedSplit {
	t.Helper()
	srv := testServer(t)
	facilitator := signup(t, srv, "Fay")
	member := signup(t, srv, "Mel")
	_, space := createSpace(t, srv, name, facilitator)
	slug := space["slug"].(string)
	passcode, _ := space["passcode"].(string)
	if resp := joinSpace(t, srv, slug, member, passcode); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	resp, created := createSessionWithConfig(t, srv, slug, "poker", "Sprint", fmt.Sprintf(`{"deck":%q}`, deck), facilitator)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create session: %d %v", resp.StatusCode, created)
	}
	split := estimatedSplit{draftedSplit: draftedSplit{srv: srv, facilitator: facilitator, member: member, sessionID: created["id"].(string)}}
	split.parentID = addStory(t, srv, split.sessionID, "Parent", facilitator)
	for index, title := range titles {
		split.children = append(split.children, draftChild(t, srv, split.sessionID, split.parentID, title, fmt.Sprintf("child-%d", index), index, facilitator))
	}
	split.first, split.second = split.children[0], split.children[1]
	split.act(t, "adopt", split.adoptionBody(t), http.StatusNoContent)
	return split
}

func (split estimatedSplit) estimate(t *testing.T, storyID, card string) {
	t.Helper()
	revision := split.story(t, storyID)["contentRevision"]
	if resp := patchStory(t, split.srv, split.sessionID, storyID, fmt.Sprintf(`"estimate":%q,"expectedRevision":%v`, card, revision), split.facilitator); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("estimate %s: %d", card, resp.StatusCode)
	}
}

func (split estimatedSplit) totalBody(t *testing.T, total string) map[string]any {
	t.Helper()
	parent := split.story(t, split.parentID)
	return map[string]any{"parentId": split.parentID, "answer": "total", "expectedTotal": total, "expectedRevision": parent["contentRevision"], "expectedSplitRevision": parent["splitRevision"], "children": split.activeChildRevisions(t)}
}

func TestParentEstimateTotalIsComputedOnTheServer(t *testing.T) {
	split := commitSplitOnDeck(t, "Parent total", "modified-fibonacci", "Half", "Three", "Five")
	unavailable := "a total needs every story in the split to have a current numeric estimate"
	split.estimate(t, split.children[0], "½")
	split.estimate(t, split.children[1], "3")
	if out := split.act(t, "parent-estimate", split.totalBody(t, "3.5"), http.StatusConflict); out["error"] != unavailable {
		t.Fatalf("total with an unestimated story: %v", out)
	}
	split.estimate(t, split.children[2], "5")

	if out := split.act(t, "parent-estimate", split.totalBody(t, "9"), http.StatusConflict); out["error"] != "story or split changed; review latest and your input before saving" {
		t.Fatalf("total the client got wrong: %v", out)
	}
	stale := split.totalBody(t, "8.5")
	stale["children"].(map[string]any)[split.children[0]] = 0
	split.act(t, "parent-estimate", stale, http.StatusConflict)
	splitAction(t, split.srv, split.sessionID, "parent-estimate", split.totalBody(t, "8.5"), split.member, http.StatusForbidden)
	_, _, otherSession := setupSession(t, split.srv, "Parent total elsewhere")
	splitAction(t, split.srv, otherSession, "parent-estimate", split.totalBody(t, "8.5"), split.facilitator, http.StatusNotFound)
	missingAnswer := split.totalBody(t, "8.5")
	missingAnswer["answer"] = "average"
	split.act(t, "parent-estimate", missingAnswer, http.StatusBadRequest)
	if parent := split.story(t, split.parentID); parent["estimate"] != nil || parent["parentEstimateAnsweredRevision"] != nil {
		t.Fatalf("a refused total changed the parent: %v", parent)
	}

	split.act(t, "parent-estimate", split.totalBody(t, "8.5"), http.StatusNoContent)
	parent := split.story(t, split.parentID)
	if parent["estimate"] != "8.5" || parent["estimateProvenance"] != "story-total" || parent["estimateNeedsReview"] != false || parent["planningRole"] != "context" || parent["parentEstimateAnsweredRevision"] != parent["splitRevision"] {
		t.Fatalf("recorded total: %v", parent)
	}
	_, exported := fetchCSV(t, split.srv, split.sessionID, split.member)
	rows, err := csv.NewReader(strings.NewReader(exported)).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows[1:] {
		if row[6] == split.parentID && (row[3] != "8.5" || row[15] != "story-total" || row[16] != "current") {
			t.Fatalf("exported total: %v", row)
		}
	}

	split.estimate(t, split.children[1], "8")
	if parent = split.story(t, split.parentID); parent["estimate"] != "8.5" || parent["estimateNeedsReview"] != true {
		t.Fatalf("a total over a changed story is still presented as current: %v", parent)
	}
	split.act(t, "parent-estimate", split.totalBody(t, "13.5"), http.StatusNoContent)
	if parent = split.story(t, split.parentID); parent["estimate"] != "13.5" || parent["estimateNeedsReview"] != false {
		t.Fatalf("refreshed total: %v", parent)
	}
	removal := map[string]any{"storyId": split.children[0], "expectedRevision": split.story(t, split.children[0])["contentRevision"], "expectedSplitRevision": parent["splitRevision"]}
	split.act(t, "remove-child", removal, http.StatusNoContent)
	if parent = split.story(t, split.parentID); parent["estimateNeedsReview"] != true || parent["parentEstimateAnsweredRevision"] == parent["splitRevision"] {
		t.Fatalf("a total that still counts a removed story: %v", parent)
	}
	split.act(t, "parent-estimate", split.totalBody(t, "13"), http.StatusNoContent)
	split.act(t, "undo-split", split.undoBody(t), http.StatusNoContent)
	if parent = split.story(t, split.parentID); parent["estimate"] != "13" || parent["estimateProvenance"] != "story-total" || parent["estimateNeedsReview"] != true {
		t.Fatalf("a total after its stories went back to drafts: %v", parent)
	}
}

func TestParentEstimateTotalNeedsANumericDeck(t *testing.T) {
	split := commitSplitOnDeck(t, "Parent total sizes", "tshirt", "Small", "Medium")
	split.estimate(t, split.children[0], "S")
	split.estimate(t, split.children[1], "M")
	if out := split.act(t, "parent-estimate", split.totalBody(t, "SM"), http.StatusConflict); out["error"] != "a total needs every story in the split to have a current numeric estimate" {
		t.Fatalf("total on a deck without numbers: %v", out)
	}
	if split.story(t, split.parentID)["estimate"] != nil {
		t.Fatal("a refused total was recorded")
	}
}

func TestParentEstimateTotalRefusesAStoryThatNeedsReview(t *testing.T) {
	split := commitSplitOnDeck(t, "Parent total review", "fibonacci", "One", "Two")
	split.estimate(t, split.children[0], "3")
	split.estimate(t, split.children[1], "5")
	if resp := patchStory(t, split.srv, split.sessionID, split.children[1], fmt.Sprintf(`"notes":"Scope grew","expectedRevision":%v`, split.story(t, split.children[1])["contentRevision"]), split.facilitator); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("scope change: %d", resp.StatusCode)
	}
	split.act(t, "parent-estimate", split.totalBody(t, "8"), http.StatusConflict)
	split.act(t, "parent-estimate", map[string]any{"parentId": split.children[0], "answer": "none", "expectedSplitRevision": 0}, http.StatusConflict)
	split.act(t, "parent-estimate", map[string]any{"parentId": split.parentID, "answer": "none", "expectedSplitRevision": 0}, http.StatusConflict)
	flat := addStory(t, split.srv, split.sessionID, "Flat", split.facilitator)
	if out := split.act(t, "parent-estimate", map[string]any{"parentId": flat, "answer": "none", "expectedSplitRevision": 0}, http.StatusConflict); out["error"] != "this story is not a committed split, so there is nothing to undo" {
		t.Fatalf("answering for a story that is not a committed split: %v", out)
	}
	parent := split.story(t, split.parentID)
	split.act(t, "parent-estimate", map[string]any{"parentId": split.parentID, "answer": "none", "expectedSplitRevision": parent["splitRevision"]}, http.StatusNoContent)
	if after := split.story(t, split.parentID); after["estimate"] != nil || after["parentEstimateAnsweredRevision"] != after["splitRevision"] || after["contentRevision"] != parent["contentRevision"] {
		t.Fatalf("declining did not record only the answer: %v", after)
	}
}

func TestCommittedParentCanBeDealtAndEstimatedWithTheTeam(t *testing.T) {
	split := commitSplitOnDeck(t, "Parent round", "fibonacci", "One", "Two")
	srv, facilitator, sessionID := split.srv, split.facilitator, split.sessionID
	split.estimate(t, split.children[0], "3")
	split.estimate(t, split.children[1], "5")
	childrenBefore := []any{split.story(t, split.children[0]), split.story(t, split.children[1])}

	selectStory(t, srv, sessionID, split.parentID, facilitator)
	env := splitState(t, srv, sessionID, split.member)
	state := env["state"].(map[string]any)
	parent := currentStory(env, split.parentID)
	if state["currentStoryId"] != split.parentID || parent["planningRole"] != "context" || parent["parentEstimateAnsweredRevision"] != parent["splitRevision"] {
		t.Fatalf("the committed parent was not dealt as it is: %v", parent)
	}
	round := state["roundVersion"]
	if resp := patchStory(t, srv, sessionID, split.parentID, fmt.Sprintf(`"estimate":"8","expectedRevision":%v,"endRound":true,"expectedCurrentStoryId":%q,"expectedRoundVersion":%v`, parent["contentRevision"], split.parentID, round), facilitator); resp.StatusCode != http.StatusConflict {
		t.Fatalf("facilitator-set estimate on a committed parent: %d", resp.StatusCode)
	}
	splitAction(t, srv, sessionID, "vote", map[string]any{"storyId": split.parentID, "value": "8", "expectedRoundVersion": round}, split.member, http.StatusNoContent)
	splitAction(t, srv, sessionID, "reveal", map[string]any{"storyId": split.parentID, "expectedRoundVersion": round}, facilitator, http.StatusNoContent)
	if resp := patchStory(t, srv, sessionID, split.parentID, fmt.Sprintf(`"estimate":"8","expectedRevision":%v,"acceptanceMode":"poker","expectedScopeRevision":%v,"expectedRoundVersion":%v`, parent["contentRevision"], parent["scopeRevision"], round), facilitator); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("poker acceptance on the committed parent: %d", resp.StatusCode)
	}
	parent = split.story(t, split.parentID)
	if parent["estimate"] != "8" || parent["estimateProvenance"] != "poker" || parent["planningRole"] != "context" || parent["estimateNeedsReview"] != false {
		t.Fatalf("parent estimated with the team: %v", parent)
	}
	for index, before := range childrenBefore {
		after := split.story(t, split.children[index])
		for _, key := range []string{"estimate", "planningRole", "contentRevision", "scopeRevision", "estimateNeedsReview"} {
			if before.(map[string]any)[key] != after[key] {
				t.Fatalf("the parent's round disturbed a story: %s %v -> %v", key, before, after)
			}
		}
	}
	split.estimate(t, split.children[0], "13")
	if parent = split.story(t, split.parentID); parent["estimateNeedsReview"] != false {
		t.Fatalf("a Poker estimate on the parent was flagged by a story change: %v", parent)
	}

	selectStory(t, srv, sessionID, split.children[1], facilitator)
	env = splitState(t, srv, sessionID, facilitator)
	again := map[string]any{"storyId": split.parentID, "expectedCurrentStoryId": split.children[1], "expectedRoundVersion": env["state"].(map[string]any)["roundVersion"], "switchToChildren": true}
	splitAction(t, srv, sessionID, "select", again, facilitator, http.StatusConflict)
	again["freshRound"] = true
	splitAction(t, srv, sessionID, "select", again, facilitator, http.StatusNoContent)
	if parent = split.story(t, split.parentID); len(parent["votedUserIds"].([]any)) != 0 || parent["estimate"] != "8" {
		t.Fatalf("a fresh round on the parent: %v", parent)
	}

	env = splitState(t, srv, sessionID, facilitator)
	splitAction(t, srv, sessionID, "vote", map[string]any{"storyId": split.parentID, "value": "5", "expectedRoundVersion": env["state"].(map[string]any)["roundVersion"]}, split.member, http.StatusNoContent)
	split.act(t, "undo-split", split.undoBody(t), http.StatusNoContent)
	env = splitState(t, srv, sessionID, facilitator)
	if parent = currentStory(env, split.parentID); env["state"].(map[string]any)["currentStoryId"] != split.parentID || len(parent["votedUserIds"].([]any)) != 1 || parent["planningRole"] != "planning" {
		t.Fatalf("undo disturbed the round that is live on the parent: %v", parent)
	}
}

func TestParentTotalPausesAnEarlierPublicationApproval(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	facilitator, member, sessionID := setupSession(t, srv, "Total after approval")
	split := estimatedSplit{draftedSplit: draftedSplit{srv: srv, facilitator: facilitator, member: member, sessionID: sessionID}}
	split.parentID = addStory(t, srv, sessionID, "Parent", facilitator)
	split.first = draftChild(t, srv, sessionID, split.parentID, "One", "one", 0, facilitator)
	split.second = draftChild(t, srv, sessionID, split.parentID, "Two", "two", 1, facilitator)
	split.children = []string{split.first, split.second}
	split.act(t, "adopt", split.adoptionBody(t), http.StatusNoContent)
	split.estimate(t, split.first, "3")
	split.estimate(t, split.second, "5")

	scope := publication.Scope{SessionID: sessionID, PrincipalID: userID(t, srv, facilitator)}
	if err := pool.QueryRow(ctx, `select sp.id::text,sp.org_id::text from sessions s join spaces sp on sp.id=s.space_id where s.id=$1`, sessionID).Scan(&scope.SpaceID, &scope.OrgID); err != nil {
		t.Fatal(err)
	}
	provider := &countingPublicationProvider{capability: publication.Capability{Verified: true, Generation: "g1", Destination: "tracker", IssueType: "Story", ParentID: "PARENT-1", ParentDisposition: "excluded-from-counting", FieldID: "points", Mapping: map[string]string{"3": "3", "5": "5"}}}
	engine := &publication.Engine{Pool: pool, Provider: provider}
	request := publication.Request{ParentID: split.parentID, Children: []string{split.first, split.second}}
	preview, err := engine.Preview(ctx, scope, request)
	if err != nil {
		t.Fatal(err)
	}
	request.Fingerprint = preview.Fingerprint
	review, err := engine.Approve(ctx, scope, request)
	if err != nil {
		t.Fatal(err)
	}
	split.act(t, "parent-estimate", split.totalBody(t, "8"), http.StatusNoContent)
	if err := engine.Run(ctx, scope, review.ID); !errors.Is(err, publication.ErrPaused) {
		t.Fatalf("an approval reviewed before the parent's estimate changed still ran: %v", err)
	}
	if provider.inspects != 0 || provider.sends != 0 {
		t.Fatalf("the earlier approval reached the provider: %d reads, %d sends", provider.inspects, provider.sends)
	}
	after, err := engine.Preview(ctx, scope, request)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Steps) != len(preview.Steps) {
		t.Fatalf("the parent's total changed what would be published: %d steps, was %d", len(after.Steps), len(preview.Steps))
	}
	for index, step := range after.Steps {
		if step.Kind != preview.Steps[index].Kind || step.Value != preview.Steps[index].Value || step.Title != preview.Steps[index].Title {
			t.Fatalf("the parent's total changed a publication step: %+v", step)
		}
	}
}

func TestPokerUndoSplitLeavesARoundThatIsLiveOnAnUnestimatedParent(t *testing.T) {
	split := commitSplitOnDeck(t, "Undo under a parent round", "fibonacci", "One", "Two")
	selectStory(t, split.srv, split.sessionID, split.parentID, split.facilitator)
	round := splitState(t, split.srv, split.sessionID, split.facilitator)["state"].(map[string]any)["roundVersion"]
	splitAction(t, split.srv, split.sessionID, "vote", map[string]any{"storyId": split.parentID, "value": "5", "expectedRoundVersion": round}, split.member, http.StatusNoContent)
	split.act(t, "undo-split", split.undoBody(t), http.StatusNoContent)
	env := splitState(t, split.srv, split.sessionID, split.facilitator)
	parent := currentStory(env, split.parentID)
	if env["state"].(map[string]any)["currentStoryId"] != split.parentID || env["state"].(map[string]any)["roundVersion"] != round || parent["estimate"] != nil || len(parent["votedUserIds"].([]any)) != 1 {
		t.Fatalf("undo cleared a round that is live on the parent: %v", parent)
	}
}

func TestSplitActionsNeverEndARoundThatIsLiveOnTheParent(t *testing.T) {
	for _, isRevealed := range []bool{false, true} {
		t.Run(fmt.Sprintf("revealed=%v", isRevealed), func(t *testing.T) {
			split := commitSplitOnDeck(t, fmt.Sprintf("Parent round kept %v", isRevealed), "fibonacci", "One", "Two", "Three")
			for _, storyID := range split.children {
				split.estimate(t, storyID, "5")
			}
			selectStory(t, split.srv, split.sessionID, split.parentID, split.facilitator)
			round := splitState(t, split.srv, split.sessionID, split.facilitator)["state"].(map[string]any)["roundVersion"]
			splitAction(t, split.srv, split.sessionID, "vote", map[string]any{"storyId": split.parentID, "value": "21", "expectedRoundVersion": round}, split.member, http.StatusNoContent)
			if isRevealed {
				splitAction(t, split.srv, split.sessionID, "reveal", map[string]any{"storyId": split.parentID, "expectedRoundVersion": round}, split.facilitator, http.StatusNoContent)
			}
			roundIsUntouched := func(after string) {
				t.Helper()
				env := splitState(t, split.srv, split.sessionID, split.member)
				state := env["state"].(map[string]any)
				parent := currentStory(env, split.parentID)
				if state["currentStoryId"] != split.parentID || state["roundVersion"] != round || env["revealed"] != isRevealed || len(parent["votedUserIds"].([]any)) != 1 {
					t.Fatalf("%s ended or disturbed the round that is live on the parent: %v %v", after, state, parent)
				}
			}
			revision := func() any { return split.story(t, split.parentID)["splitRevision"] }
			reconfirm := func() map[string]any {
				body := split.adoptionBody(t)
				for _, key := range []string{"switchToChildren", "expectedCurrentStoryId", "expectedRoundVersion"} {
					delete(body, key)
				}
				return body
			}

			split.act(t, "remove-child", map[string]any{"storyId": split.children[2], "expectedRevision": split.story(t, split.children[2])["contentRevision"], "expectedSplitRevision": revision()}, http.StatusNoContent)
			roundIsUntouched("removing a story")
			split.act(t, "adopt", reconfirm(), http.StatusNoContent)
			roundIsUntouched("confirming coverage again after a removal")
			if split.story(t, split.parentID)["coverage"] != "full" {
				t.Fatal("coverage was not confirmed again")
			}
			split.act(t, "restore-child", map[string]any{"storyId": split.children[2], "expectedRevision": split.story(t, split.children[2])["contentRevision"], "expectedSplitRevision": revision()}, http.StatusNoContent)
			roundIsUntouched("bringing a story back")
			split.act(t, "adopt", reconfirm(), http.StatusNoContent)
			roundIsUntouched("confirming coverage again after a restore")
			split.act(t, "parent-estimate", map[string]any{"parentId": split.parentID, "answer": "none", "expectedSplitRevision": revision()}, http.StatusNoContent)
			roundIsUntouched("declining a parent estimate")
			if out := split.act(t, "parent-estimate", split.totalBody(t, "15"), http.StatusConflict); out["error"] != "review this round before switching, restarting or saving" {
				t.Fatalf("a total recorded over the parent's own round: %v", out)
			}
			roundIsUntouched("a refused total")

			draft := split.act(t, "child", map[string]any{"parentId": split.parentID, "title": "Four", "operationId": "four", "expectedSplitRevision": revision()}, http.StatusCreated)["storyId"].(string)
			roundIsUntouched("drafting another story")
			split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": draft, "expectedSplitRevision": revision()}, http.StatusNoContent)
			roundIsUntouched("naming a leftover")
			split.act(t, "leftover", map[string]any{"parentId": split.parentID, "storyId": "", "expectedSplitRevision": revision()}, http.StatusNoContent)
			unreviewed := reconfirm()
			split.act(t, "adopt", unreviewed, http.StatusConflict)
			roundIsUntouched("a commit of new drafts sent without reviewing the parent's round")
			split.act(t, "undo-split", split.undoBody(t), http.StatusNoContent)
			env := splitState(t, split.srv, split.sessionID, split.member)
			if env["state"].(map[string]any)["currentStoryId"] != split.parentID || env["state"].(map[string]any)["roundVersion"] != round || len(currentStory(env, split.parentID)["votedUserIds"].([]any)) != 1 {
				t.Fatalf("undo ended the round that is live on the parent: %v", env["state"])
			}
		})
	}
}

func TestCommittingNewDraftsOverALiveParentRoundNeedsItsReview(t *testing.T) {
	split := commitSplitOnDeck(t, "Parent round ended by a commit", "fibonacci", "One", "Two")
	selectStory(t, split.srv, split.sessionID, split.parentID, split.facilitator)
	state := splitState(t, split.srv, split.sessionID, split.facilitator)["state"].(map[string]any)
	splitAction(t, split.srv, split.sessionID, "vote", map[string]any{"storyId": split.parentID, "value": "8", "expectedRoundVersion": state["roundVersion"]}, split.member, http.StatusNoContent)
	split.act(t, "child", map[string]any{"parentId": split.parentID, "title": "Three", "operationId": "three", "expectedSplitRevision": split.story(t, split.parentID)["splitRevision"]}, http.StatusCreated)
	reviewed := split.adoptionBody(t)
	split.act(t, "adopt", reviewed, http.StatusNoContent)
	after := splitState(t, split.srv, split.sessionID, split.member)["state"].(map[string]any)
	if after["currentStoryId"] != nil || after["roundVersion"] == state["roundVersion"] {
		t.Fatalf("a reviewed commit of new drafts did not end the parent's round: %v", after)
	}
}

func TestSameEstimateAgainDoesNotFlagAStoryTotal(t *testing.T) {
	split := commitSplitOnDeck(t, "Unchanged estimate", "fibonacci", "One", "Two")
	split.estimate(t, split.children[0], "3")
	split.estimate(t, split.children[1], "5")
	split.act(t, "parent-estimate", split.totalBody(t, "8"), http.StatusNoContent)
	split.estimate(t, split.children[0], "3")
	if parent := split.story(t, split.parentID); parent["estimateNeedsReview"] != false {
		t.Fatalf("the same estimate again flagged the total: %v", parent)
	}
	split.estimate(t, split.children[0], "5")
	if parent := split.story(t, split.parentID); parent["estimateNeedsReview"] != true {
		t.Fatalf("a changed estimate did not flag the total: %v", parent)
	}
}

func TestDealingAnUndoneTicketOverOldVotesNeedsAFreshRound(t *testing.T) {
	split := draftSplit(t, "Undone ticket old votes")
	srv, facilitator, sessionID := split.srv, split.facilitator, split.sessionID
	selectStory(t, srv, sessionID, split.parentID, facilitator)
	round := splitState(t, srv, sessionID, facilitator)["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, sessionID, "vote", map[string]any{"storyId": split.parentID, "value": "13", "expectedRoundVersion": round}, split.member, http.StatusNoContent)
	splitAction(t, srv, sessionID, "reveal", map[string]any{"storyId": split.parentID, "expectedRoundVersion": round}, facilitator, http.StatusNoContent)
	if resp := patchStory(t, srv, sessionID, split.parentID, fmt.Sprintf(`"estimate":"13","expectedRevision":0,"acceptanceMode":"poker","expectedScopeRevision":0,"expectedRoundVersion":%v`, round), facilitator); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("accept: %d", resp.StatusCode)
	}
	split.act(t, "adopt", split.adoptionBody(t), http.StatusNoContent)
	split.act(t, "undo-split", split.undoBody(t), http.StatusNoContent)
	if len(split.story(t, split.parentID)["votedUserIds"].([]any)) != 1 {
		t.Fatal("fixture: the accepted round's vote was not kept through undo")
	}

	state := splitState(t, srv, sessionID, facilitator)["state"].(map[string]any)
	deal := map[string]any{"storyId": split.parentID, "expectedCurrentStoryId": "", "expectedRoundVersion": state["roundVersion"]}
	if out := split.act(t, "select", deal, http.StatusConflict); out["error"] != "review this round before switching, restarting or saving" {
		t.Fatalf("an undone ticket was dealt over its old votes: %v", out)
	}
	deal["freshRound"] = true
	split.act(t, "select", deal, http.StatusNoContent)
	parent := split.story(t, split.parentID)
	if len(parent["votedUserIds"].([]any)) != 0 || parent["estimate"] != "13" {
		t.Fatalf("a fresh round on the undone ticket: %v", parent)
	}

	flat := addStory(t, srv, sessionID, "Flat", facilitator)
	selectStory(t, srv, sessionID, flat, facilitator)
	if resp := vote(t, srv, sessionID, flat, "5", split.member); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote: %d", resp.StatusCode)
	}
	other := addStory(t, srv, sessionID, "Other flat", facilitator)
	selectStory(t, srv, sessionID, other, facilitator)
	selectStory(t, srv, sessionID, flat, facilitator)
	if len(split.story(t, flat)["votedUserIds"].([]any)) != 1 {
		t.Fatal("a story that was never split lost its round by being selected away and back")
	}
}
