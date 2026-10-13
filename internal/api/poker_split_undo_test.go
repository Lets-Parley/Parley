package api

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lets-parley/parley/internal/poker/publication"
)

type committedSplit struct {
	srv                    *httptest.Server
	pool                   *pgxpool.Pool
	facilitator, member    *http.Cookie
	sessionID, parentID    string
	api, ui, docs, removed string
}

func commitSplit(t *testing.T, name string) committedSplit {
	t.Helper()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, id := setupSession(t, srv, name)
	split := committedSplit{srv: srv, pool: pool, facilitator: fac, member: member, sessionID: id}
	split.parentID = addStory(t, srv, id, "Original scope", fac)
	if resp := patchStory(t, srv, id, split.parentID, `"estimate":"13"`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("parent estimate: %d", resp.StatusCode)
	}
	split.api = draftChild(t, srv, id, split.parentID, "API", "api", 0, fac)
	split.ui = draftChild(t, srv, id, split.parentID, "UI", "ui", 1, fac)
	split.docs = draftChild(t, srv, id, split.parentID, "Docs", "docs", 2, fac)
	split.removed = draftChild(t, srv, id, split.parentID, "Dropped", "dropped", 3, fac)
	if resp := patchStory(t, srv, id, split.api, `"estimate":"3","expectedRevision":0`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("draft estimate: %d", resp.StatusCode)
	}
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": split.parentID, "expectedRevision": 1, "expectedSplitRevision": 4, "coverage": "full",
		"children": map[string]int{split.api: 1, split.ui: 0, split.docs: 0, split.removed: 0}}, fac, http.StatusNoContent)
	if resp := patchStory(t, srv, id, split.ui, `"estimate":"5","expectedRevision":1`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("adopted estimate: %d", resp.StatusCode)
	}
	splitAction(t, srv, id, "dependencies", map[string]any{"parentId": split.parentID, "expectedRevision": 2, "expectedDependencyRevision": 0,
		"children": map[string]int{split.api: 2, split.ui: 2, split.docs: 1, split.removed: 1},
		"edges":    []map[string]string{{"blockerId": split.api, "dependentId": split.docs}}}, fac, http.StatusNoContent)
	parent := currentStory(splitState(t, srv, id, fac), split.parentID)
	splitAction(t, srv, id, "remove-child", map[string]any{"storyId": split.removed, "expectedRevision": 1, "expectedSplitRevision": parent["splitRevision"]}, fac, http.StatusNoContent)
	return split
}

func (split committedSplit) undoBody(t *testing.T) map[string]any {
	t.Helper()
	return undoRequest(t, split.srv, split.sessionID, split.parentID, split.facilitator)
}

func undoRequest(t *testing.T, srv *httptest.Server, sessionID, parentID string, facilitator *http.Cookie) map[string]any {
	t.Helper()
	env := splitState(t, srv, sessionID, facilitator)
	parent := currentStory(env, parentID)
	children := map[string]any{}
	for _, raw := range env["state"].(map[string]any)["stories"].([]any) {
		story := raw.(map[string]any)
		if story["parentId"] == parentID && story["removedAt"] == nil {
			children[story["id"].(string)] = story["contentRevision"]
		}
	}
	return map[string]any{"parentId": parentID, "expectedRevision": parent["contentRevision"], "expectedSplitRevision": parent["splitRevision"], "children": children}
}

func (split committedSplit) progress(t *testing.T) string {
	t.Helper()
	slug := spaceSlugOf(t, split.srv, split.sessionID, split.facilitator)
	return fieldJSON(t, spaceSessionRows(t, split.srv, slug, split.facilitator)[split.sessionID], "progress")
}

func TestPokerUndoSplitReturnsParentAndChildrenToDraft(t *testing.T) {
	split := commitSplit(t, "Undo split")
	srv, fac, id := split.srv, split.facilitator, split.sessionID
	if got := split.progress(t); got != `{"kind":"poker","settled":2,"total":3}` {
		t.Fatalf("committed progress: %s", got)
	}
	before := splitState(t, srv, id, fac)
	splitRevision := currentStory(before, split.parentID)["splitRevision"].(float64)
	splitAction(t, srv, id, "undo-split", split.undoBody(t), fac, http.StatusNoContent)

	env := splitState(t, srv, id, fac)
	parent := currentStory(env, split.parentID)
	if parent["planningRole"] != "planning" || parent["coverage"] != nil || parent["estimate"] != "13" || parent["estimateNeedsReview"] != false {
		t.Fatalf("parent is not an ordinary planning story again: %v", parent)
	}
	if parent["splitRevision"] != splitRevision+1 {
		t.Fatalf("split revision %v, want %v", parent["splitRevision"], splitRevision+1)
	}
	for storyID, estimate := range map[string]any{split.api: "3", split.ui: "5", split.docs: nil} {
		child := currentStory(env, storyID)
		if child["planningRole"] != "proposed" || child["removedAt"] != nil || child["isRemainder"] != false || child["estimate"] != estimate {
			t.Fatalf("child did not return to a draft with its estimate: %v", child)
		}
		if child["estimateNeedsReview"] != (estimate != nil) {
			t.Fatalf("kept estimate must be flagged for review, and only a kept estimate: %v", child)
		}
	}
	dropped := currentStory(env, split.removed)
	if dropped["removedAt"] == nil || dropped["title"] != "Dropped" || dropped["planningRole"] != "proposed" {
		t.Fatalf("removed child must stay removed and restorable as a draft: %v", dropped)
	}
	edges := env["state"].(map[string]any)["dependencies"].([]any)
	if len(edges) != 1 || edges[0].(map[string]any)["blockerId"] != split.api || edges[0].(map[string]any)["dependentId"] != split.docs || edges[0].(map[string]any)["reviewState"] != "planning" {
		t.Fatalf("sibling dependency was not kept: %v", edges)
	}
	if got := split.progress(t); got != `{"kind":"poker","settled":1,"total":1}` {
		t.Fatalf("draft children counted after undo: %s", got)
	}

	_, body := fetchCSV(t, srv, id, split.member)
	rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows[1:] {
		switch row[6] {
		case split.parentID:
			if row[8] != "planning" || row[3] != "13" || row[16] != "current" {
				t.Fatalf("exported parent: %v", row)
			}
		case split.api, split.ui:
			if row[8] != "proposed" || row[2] != "needs-review" || row[16] != "needs-review" {
				t.Fatalf("exported draft estimate is presented as current: %v", row)
			}
		case split.docs:
			if row[8] != "proposed" || row[16] != "unestimated" {
				t.Fatalf("exported unestimated draft: %v", row)
			}
		}
	}

	splitAction(t, srv, id, "undo-split", split.undoBody(t), fac, http.StatusConflict)
	parent = currentStory(splitState(t, srv, id, fac), split.parentID)
	children := map[string]any{}
	for _, storyID := range []string{split.api, split.ui, split.docs} {
		children[storyID] = currentStory(splitState(t, srv, id, fac), storyID)["contentRevision"]
	}
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": split.parentID, "expectedRevision": parent["contentRevision"], "expectedSplitRevision": parent["splitRevision"], "coverage": "full", "children": children}, fac, http.StatusNoContent)
	again := splitState(t, srv, id, fac)
	if child := currentStory(again, split.api); child["planningRole"] != "planning" || child["estimate"] != "3" || child["estimateNeedsReview"] != true {
		t.Fatalf("re-split presented an old estimate as current: %v", child)
	}
	if got := split.progress(t); got != `{"kind":"poker","settled":0,"total":3}` {
		t.Fatalf("re-split counted estimates that need review: %s", got)
	}
}

func TestPokerUndoSplitRestoredChildComesBackAsDraft(t *testing.T) {
	split := commitSplit(t, "Undo then restore")
	splitAction(t, split.srv, split.sessionID, "undo-split", split.undoBody(t), split.facilitator, http.StatusNoContent)
	env := splitState(t, split.srv, split.sessionID, split.facilitator)
	dropped, parent := currentStory(env, split.removed), currentStory(env, split.parentID)
	splitAction(t, split.srv, split.sessionID, "restore-child", map[string]any{"storyId": split.removed, "expectedRevision": dropped["contentRevision"], "expectedSplitRevision": parent["splitRevision"]}, split.facilitator, http.StatusNoContent)
	env = splitState(t, split.srv, split.sessionID, split.facilitator)
	if child := currentStory(env, split.removed); child["planningRole"] != "proposed" || child["removedAt"] != nil {
		t.Fatalf("restored child: %v", child)
	}
	if parent := currentStory(env, split.parentID); parent["planningRole"] != "planning" || parent["coverage"] != nil {
		t.Fatalf("restoring a draft changed the reverted parent: %v", parent)
	}
}

func TestPokerUndoSplitRefusedWhenAChildMayExistInTheTracker(t *testing.T) {
	for state, isBlocking := range map[string]bool{"pending": false, "unknown": true, "confirmed": true, "failed": false, "local-only": false, "waiting-for-issues": false} {
		t.Run(state, func(t *testing.T) {
			split := commitSplit(t, "Published "+state)
			if _, err := split.pool.Exec(context.Background(), `insert into poker_publication_steps(operation_key,session_id,parent_id,target_key,issue_type,kind,state)
				values($1,$2,$3,$1,'Story','create',$4)`, "create-"+state, split.sessionID, split.parentID, state); err != nil {
				t.Fatal(err)
			}
			if !isBlocking {
				splitAction(t, split.srv, split.sessionID, "undo-split", split.undoBody(t), split.facilitator, http.StatusNoContent)
				return
			}
			out := splitAction(t, split.srv, split.sessionID, "undo-split", split.undoBody(t), split.facilitator, http.StatusConflict)
			want := "this split has stories that may already be created in the tracker, so it cannot be undone here"
			if state == "confirmed" {
				want = "this split has stories already created in the tracker, so it cannot be undone here"
			}
			if out["error"] != want {
				t.Fatalf("refusal: %v", out)
			}
			env := splitState(t, split.srv, split.sessionID, split.facilitator)
			if currentStory(env, split.parentID)["planningRole"] != "context" || currentStory(env, split.api)["planningRole"] != "planning" {
				t.Fatal("a refused undo changed the split")
			}
		})
	}
}

func TestPokerUndoSplitIsNotBlockedByStepsThatCreateNothing(t *testing.T) {
	for _, kind := range []string{"parent", "project", "estimate", "dependency", "remove-dependency"} {
		for _, state := range []string{"unknown", "confirmed"} {
			t.Run(kind+" "+state, func(t *testing.T) {
				split := commitSplit(t, "Published "+kind+" "+state)
				if _, err := split.pool.Exec(context.Background(), `insert into poker_publication_steps(operation_key,session_id,parent_id,target_key,issue_type,kind,state)
					values($1,$2,$3,$1,'Story',$4,$5)`, kind+"-"+state, split.sessionID, split.parentID, kind, state); err != nil {
					t.Fatal(err)
				}
				splitAction(t, split.srv, split.sessionID, "undo-split", split.undoBody(t), split.facilitator, http.StatusNoContent)
			})
		}
	}
}

type countingPublicationProvider struct {
	capability      publication.Capability
	inspects, sends int
}

func (provider *countingPublicationProvider) Capability(context.Context, publication.Scope) (publication.Capability, error) {
	return provider.capability, nil
}

func (provider *countingPublicationProvider) Inspect(context.Context, publication.Scope, publication.Step) (publication.Observation, error) {
	provider.inspects++
	return publication.Observation{Known: true, MutationAllowed: true}, nil
}

func (provider *countingPublicationProvider) Apply(context.Context, publication.Scope, publication.Step) (publication.Outcome, error) {
	provider.sends++
	return publication.Confirmed, nil
}

func TestPokerUndoSplitFencesAnApprovalThatWasNeverSent(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, _, id := setupSession(t, srv, "Approved then undone")
	parent := addStory(t, srv, id, "Parent", fac)
	first := draftChild(t, srv, id, parent, "One", "one", 0, fac)
	second := draftChild(t, srv, id, parent, "Two", "two", 1, fac)
	adoptBoth := func() {
		t.Helper()
		env := splitState(t, srv, id, fac)
		story := currentStory(env, parent)
		splitAction(t, srv, id, "adopt", map[string]any{"parentId": parent, "expectedRevision": story["contentRevision"], "expectedSplitRevision": story["splitRevision"], "coverage": "full",
			"children": map[string]any{first: currentStory(env, first)["contentRevision"], second: currentStory(env, second)["contentRevision"]}}, fac, http.StatusNoContent)
	}
	adoptBoth()

	scope := publication.Scope{SessionID: id, PrincipalID: userID(t, srv, fac)}
	if err := pool.QueryRow(ctx, `select sp.id::text,sp.org_id::text from sessions s join spaces sp on sp.id=s.space_id where s.id=$1`, id).Scan(&scope.SpaceID, &scope.OrgID); err != nil {
		t.Fatal(err)
	}
	provider := &countingPublicationProvider{capability: publication.Capability{Verified: true, Generation: "g1", Destination: "tracker", IssueType: "Story", ParentID: "PARENT-1", ParentDisposition: "excluded-from-counting", FieldID: "points"}}
	engine := &publication.Engine{Pool: pool, Provider: provider}
	request := publication.Request{ParentID: parent, Children: []string{first, second}}
	preview, err := engine.Preview(ctx, scope, request)
	if err != nil {
		t.Fatal(err)
	}
	request.Fingerprint = preview.Fingerprint
	review, err := engine.Approve(ctx, scope, request)
	if err != nil {
		t.Fatal(err)
	}
	creationStates := func() string {
		t.Helper()
		var states string
		if err := pool.QueryRow(ctx, `select string_agg(state||':'||attempts,',' order by operation_key) from poker_publication_steps where session_id=$1 and parent_id=$2 and kind='create'`, id, parent).Scan(&states); err != nil {
			t.Fatal(err)
		}
		return states
	}
	if got := creationStates(); got != "pending:0,pending:0" {
		t.Fatalf("approved creations: %s", got)
	}

	splitAction(t, srv, id, "undo-split", undoRequest(t, srv, id, parent, fac), fac, http.StatusNoContent)
	if err := engine.Run(ctx, scope, review.ID); !errors.Is(err, publication.ErrPaused) {
		t.Fatalf("stale approval ran after undo: %v", err)
	}
	adoptBoth()
	if err := engine.Run(ctx, scope, review.ID); !errors.Is(err, publication.ErrPaused) {
		t.Fatalf("stale approval ran after the split was made again: %v", err)
	}
	if provider.inspects != 0 || provider.sends != 0 {
		t.Fatalf("stale approval reached the provider: %d reads, %d sends", provider.inspects, provider.sends)
	}
	if got := creationStates(); got != "pending:0,pending:0" {
		t.Fatalf("stale approval advanced a creation: %s", got)
	}
}

func TestPokerUndoSplitClearsTheLeftoverFlag(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Undo with a leftover")
	parent := addStory(t, srv, id, "Parent", fac)
	first := draftChild(t, srv, id, parent, "One", "one", 0, fac)
	second := draftChild(t, srv, id, parent, "Two", "two", 1, fac)
	leftover := draftChild(t, srv, id, parent, "Everything else", "leftover", 2, fac)
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": parent, "expectedRevision": 0, "expectedSplitRevision": 3, "coverage": "remainder", "remainderId": leftover,
		"children": map[string]int{first: 0, second: 0, leftover: 0}}, fac, http.StatusNoContent)
	env := splitState(t, srv, id, fac)
	if currentStory(env, leftover)["isRemainder"] != true || currentStory(env, parent)["coverage"] != "remainder" {
		t.Fatalf("fixture has no leftover story: %v", currentStory(env, leftover))
	}
	splitAction(t, srv, id, "undo-split", undoRequest(t, srv, id, parent, fac), fac, http.StatusNoContent)
	env = splitState(t, srv, id, fac)
	for _, storyID := range []string{first, second, leftover} {
		if child := currentStory(env, storyID); child["isRemainder"] != false || child["planningRole"] != "proposed" {
			t.Fatalf("draft kept the leftover flag: %v", child)
		}
	}
	if currentStory(env, parent)["coverage"] != nil {
		t.Fatalf("parent kept its coverage: %v", currentStory(env, parent))
	}
}

func TestPokerUndoSplitReturnsTheParentWithNoRound(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Undo after a parent round")
	parent := addStory(t, srv, id, "Parent", fac)
	first := draftChild(t, srv, id, parent, "One", "one", 0, fac)
	second := draftChild(t, srv, id, parent, "Two", "two", 1, fac)
	selectStory(t, srv, id, parent, fac)
	round := splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "vote", map[string]any{"storyId": parent, "value": "13", "expectedRoundVersion": round}, member, http.StatusNoContent)
	splitAction(t, srv, id, "reveal", map[string]any{"storyId": parent, "expectedRoundVersion": round}, fac, http.StatusNoContent)
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": parent, "expectedRevision": 0, "expectedSplitRevision": 2, "coverage": "full", "children": map[string]int{first: 0, second: 0},
		"switchToChildren": true, "expectedCurrentStoryId": parent, "expectedRoundVersion": round}, fac, http.StatusNoContent)
	env := splitState(t, srv, id, fac)
	if len(currentStory(env, parent)["votedUserIds"].([]any)) != 1 {
		t.Fatalf("fixture lost the parent's vote at adoption: %v", currentStory(env, parent))
	}
	story := currentStory(env, parent)
	splitAction(t, srv, id, "undo-split", undoRequest(t, srv, id, parent, fac), fac, http.StatusNoContent)
	if story = currentStory(splitState(t, srv, id, fac), parent); len(story["votedUserIds"].([]any)) != 0 {
		t.Fatalf("undo kept the parent's votes from before the split: %v", story)
	}

	selectStory(t, srv, id, parent, fac)
	round = splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "reveal", map[string]any{"storyId": parent, "expectedRoundVersion": round}, fac, http.StatusNoContent)
	env = splitState(t, srv, id, member)
	if story = currentStory(env, parent); env["revealed"] != true || story["votes"] != nil {
		t.Fatalf("dealing the parent again revealed votes from before the split: %v", story)
	}
}

func TestPokerDiscardedDraftsDoNotCountTowardTheChildCap(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Split again after undo")
	parent := addStory(t, srv, id, "Parent", fac)
	revisions := func() (float64, float64) {
		t.Helper()
		story := currentStory(splitState(t, srv, id, fac), parent)
		return story["contentRevision"].(float64), story["splitRevision"].(float64)
	}
	add := func(title string, want int) string {
		t.Helper()
		_, split := revisions()
		out := splitAction(t, srv, id, "child", map[string]any{"parentId": parent, "title": title, "operationId": strings.ReplaceAll(title, " ", "-"), "expectedSplitRevision": split}, fac, want)
		storyID, _ := out["storyId"].(string)
		return storyID
	}
	setRemoved := func(action, storyID string, want int) map[string]any {
		t.Helper()
		_, split := revisions()
		return splitAction(t, srv, id, action, map[string]any{"storyId": storyID, "expectedRevision": currentStory(splitState(t, srv, id, fac), storyID)["contentRevision"], "expectedSplitRevision": split}, fac, want)
	}
	children := map[string]int{}
	var committed []string
	for index := 0; index < 6; index++ {
		storyID := add(fmt.Sprintf("First attempt %d", index), http.StatusCreated)
		children[storyID] = 0
		committed = append(committed, storyID)
	}
	content, split := revisions()
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": parent, "expectedRevision": content, "expectedSplitRevision": split, "coverage": "full", "children": children}, fac, http.StatusNoContent)
	setRemoved("remove-child", committed[5], http.StatusNoContent)
	content, split = revisions()
	splitAction(t, srv, id, "undo-split", undoRequest(t, srv, id, parent, fac), fac, http.StatusNoContent)
	for _, storyID := range committed[:5] {
		setRemoved("remove-child", storyID, http.StatusNoContent)
	}

	var replacements []string
	for index := 0; index < 10; index++ {
		replacements = append(replacements, add(fmt.Sprintf("Second attempt %d", index), http.StatusCreated))
	}
	wantLimit := "a split can hold at most 10 stories; removed stories that were committed still count, discarded drafts do not"
	_, split = revisions()
	if out := splitAction(t, srv, id, "child", map[string]any{"parentId": parent, "title": "One too many", "operationId": "one-too-many", "expectedSplitRevision": split}, fac, http.StatusConflict); out["error"] != wantLimit {
		t.Fatalf("eleventh story: %v", out)
	}
	if out := setRemoved("restore-child", committed[0], http.StatusConflict); out["error"] != wantLimit {
		t.Fatalf("restoring a discarded draft into a full split: %v", out)
	}
	setRemoved("remove-child", replacements[0], http.StatusNoContent)
	setRemoved("restore-child", committed[0], http.StatusNoContent)
	add("Still one too many", http.StatusConflict)
}

func TestPokerUndoSplitIgnoresAnotherSplitsReceipts(t *testing.T) {
	split := commitSplit(t, "Neighbor published")
	other := addStory(t, split.srv, split.sessionID, "Neighbor", split.facilitator)
	if _, err := split.pool.Exec(context.Background(), `insert into poker_publication_steps(operation_key,session_id,parent_id,target_key,issue_type,kind,state)
		values('neighbor',$1,$2,'neighbor','Story','create','confirmed')`, split.sessionID, other); err != nil {
		t.Fatal(err)
	}
	splitAction(t, split.srv, split.sessionID, "undo-split", split.undoBody(t), split.facilitator, http.StatusNoContent)
}

func TestPokerUndoSplitStaleAndMalformedRequests(t *testing.T) {
	split := commitSplit(t, "Stale undo")
	srv, fac, id := split.srv, split.facilitator, split.sessionID
	fresh := split.undoBody(t)
	for name, change := range map[string]func(map[string]any){
		"stale split revision":   func(body map[string]any) { body["expectedSplitRevision"] = body["expectedSplitRevision"].(float64) - 1 },
		"stale content revision": func(body map[string]any) { body["expectedRevision"] = body["expectedRevision"].(float64) - 1 },
	} {
		body := split.undoBody(t)
		change(body)
		out := splitAction(t, srv, id, "undo-split", body, fac, http.StatusConflict)
		if out["error"] != "story or split changed; review latest and your input before saving" {
			t.Fatalf("%s: %v", name, out)
		}
	}
	splitAction(t, srv, id, "undo-split", map[string]any{"parentId": split.parentID}, fac, http.StatusBadRequest)
	if currentStory(splitState(t, srv, id, fac), split.parentID)["planningRole"] != "context" {
		t.Fatal("a refused undo changed the parent")
	}
	splitAction(t, srv, id, "undo-split", fresh, fac, http.StatusNoContent)
}

func TestPokerUndoSplitRefusesAnythingButACommittedSplit(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Nothing to undo")
	flat := addStory(t, srv, id, "Flat", fac)
	drafted := addStory(t, srv, id, "Drafted", fac)
	child := draftChild(t, srv, id, drafted, "Draft child", "draft", 0, fac)
	draftChild(t, srv, id, drafted, "Second draft", "draft-two", 1, fac)
	want := "this story is not a committed split, so there is nothing to undo"
	for name, body := range map[string]map[string]any{
		"flat story":    {"parentId": flat, "expectedRevision": 0, "expectedSplitRevision": 0},
		"drafted split": {"parentId": drafted, "expectedRevision": 0, "expectedSplitRevision": 2},
	} {
		if out := splitAction(t, srv, id, "undo-split", body, fac, http.StatusConflict); out["error"] != want {
			t.Fatalf("%s: %v", name, out)
		}
	}
	splitAction(t, srv, id, "undo-split", map[string]any{"parentId": child, "expectedRevision": 0, "expectedSplitRevision": 0}, fac, http.StatusConflict)
	if draft := currentStory(splitState(t, srv, id, fac), child); draft["planningRole"] != "proposed" {
		t.Fatalf("refused undo changed a draft: %v", draft)
	}
}

func TestPokerUndoSplitAuthority(t *testing.T) {
	split := commitSplit(t, "Undo authority")
	srv, id := split.srv, split.sessionID
	body := split.undoBody(t)
	splitAction(t, srv, id, "undo-split", body, split.member, http.StatusForbidden)
	splitAction(t, srv, id, "undo-split", body, signup(t, srv, "Outsider"), http.StatusNotFound)

	_, minted := mintLink(t, srv, id, split.facilitator)
	token, _ := minted["token"].(string)
	if token == "" {
		t.Fatalf("mint returned no token: %v", minted)
	}
	guest := redeemAs(t, srv, token, "Guest")
	splitAction(t, srv, id, "undo-split", body, guest, http.StatusForbidden)

	otherFacilitator, _, otherSession := setupSession(t, srv, "Other tenant room")
	var otherOrg string
	if err := split.pool.QueryRow(context.Background(), "insert into orgs(slug,name,claim_value) values($1,'Other tenant',$1) returning id::text", "undo-"+randomSlugSuffix(t)).Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	if _, err := split.pool.Exec(context.Background(), "update spaces set org_id=$2 where id=(select space_id from sessions where id=$1)", otherSession, otherOrg); err != nil {
		t.Fatal(err)
	}
	if _, err := split.pool.Exec(context.Background(), "insert into org_members(org_id,user_id,role) values($1,$2,'admin')", otherOrg, userID(t, srv, otherFacilitator)); err != nil {
		t.Fatal(err)
	}
	otherParent := addStory(t, srv, otherSession, "Other tenant parent", otherFacilitator)
	otherFirst := draftChild(t, srv, otherSession, otherParent, "One", "one", 0, otherFacilitator)
	otherSecond := draftChild(t, srv, otherSession, otherParent, "Two", "two", 1, otherFacilitator)
	splitAction(t, srv, otherSession, "adopt", map[string]any{"parentId": otherParent, "expectedRevision": 0, "expectedSplitRevision": 2, "coverage": "full", "children": map[string]int{otherFirst: 0, otherSecond: 0}}, otherFacilitator, http.StatusNoContent)
	splitAction(t, srv, otherSession, "undo-split", body, otherFacilitator, http.StatusNotFound)
	splitAction(t, srv, otherSession, "undo-split", body, split.facilitator, http.StatusNotFound)
	splitAction(t, srv, id, "undo-split", map[string]any{"parentId": otherParent, "expectedRevision": 1, "expectedSplitRevision": 3}, split.facilitator, http.StatusNotFound)
	if currentStory(splitState(t, srv, otherSession, otherFacilitator), otherParent)["planningRole"] != "context" {
		t.Fatal("a caller from another org undid a split")
	}

	env := splitState(t, srv, id, split.facilitator)
	if currentStory(env, split.parentID)["planningRole"] != "context" || currentStory(env, split.api)["planningRole"] != "planning" {
		t.Fatal("a refused caller undid the split")
	}
}

func TestPokerUndoSplitEmbeddedAuthorityParity(t *testing.T) {
	srv := embedServer(t, testPool(t))
	fac, member, id := setupSession(t, srv, "Embedded undo")
	parent := addStory(t, srv, id, "Parent", fac)
	first := draftChild(t, srv, id, parent, "One", "one", 0, fac)
	second := draftChild(t, srv, id, parent, "Two", "two", 1, fac)
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": parent, "expectedRevision": 0, "expectedSplitRevision": 2, "coverage": "full", "children": map[string]int{first: 0, second: 0}}, fac, http.StatusNoContent)
	body := fmt.Sprintf(`{"parentId":%q,"expectedRevision":1,"expectedSplitRevision":3,"children":{%q:1,%q:1}}`, parent, first, second)
	if got := bearerStatus(t, srv, http.MethodPost, "/api/sessions/"+id+"/actions/undo-split", body, embedToken(t, srv, member)); got != http.StatusForbidden {
		t.Fatalf("embedded participant undid a split: %d", got)
	}
	if currentStory(splitState(t, srv, id, fac), parent)["planningRole"] != "context" {
		t.Fatal("embedded participant changed the split")
	}
	if got := bearerStatus(t, srv, http.MethodPost, "/api/sessions/"+id+"/actions/undo-split", body, embedToken(t, srv, fac)); got != http.StatusNoContent {
		t.Fatalf("embedded facilitator parity: %d", got)
	}
}

func TestPokerUndoSplitClearsAChildFromTheTableOnlyAfterReview(t *testing.T) {
	split := commitSplit(t, "Undo on the table")
	srv, fac, id := split.srv, split.facilitator, split.sessionID
	selectStory(t, srv, id, split.docs, fac)
	round := splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"].(float64)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": split.docs, "value": "5", "expectedRoundVersion": round}, split.member, http.StatusNoContent)

	body := split.undoBody(t)
	out := splitAction(t, srv, id, "undo-split", body, fac, http.StatusConflict)
	if out["error"] != "review this round before switching, restarting or saving" {
		t.Fatalf("a live round was not held for review: %v", out)
	}
	body["endRound"] = true
	body["expectedCurrentStoryId"] = split.docs
	body["expectedRoundVersion"] = round - 1
	splitAction(t, srv, id, "undo-split", body, fac, http.StatusConflict)
	env := splitState(t, srv, id, fac)
	if env["state"].(map[string]any)["currentStoryId"] != split.docs || currentStory(env, split.parentID)["planningRole"] != "context" {
		t.Fatalf("a refused undo cleared the table: %v", env["state"])
	}

	body["expectedRoundVersion"] = round
	splitAction(t, srv, id, "undo-split", body, fac, http.StatusNoContent)
	env = splitState(t, srv, id, split.member)
	state := env["state"].(map[string]any)
	if state["currentStoryId"] != nil || env["revealed"] != false || state["roundVersion"] != round+1 {
		t.Fatalf("table was not cleared the way removal clears it: %v", state)
	}
	docs := currentStory(env, split.docs)
	if len(docs["votedUserIds"].([]any)) != 1 || docs["votes"] != nil || docs["results"] != nil {
		t.Fatalf("votes were moved, dropped or revealed: %v", docs)
	}
	if _, exported := fetchCSV(t, srv, id, split.member); strings.Contains(exported, "Mel: 5") {
		t.Fatal("undo leaked a hidden vote into the export")
	}
	selectStory(t, srv, id, split.parentID, fac)
	fresh := splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"].(float64)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": split.docs, "value": "8", "expectedRoundVersion": round}, split.member, http.StatusConflict)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": split.docs, "value": "8", "expectedRoundVersion": fresh}, split.member, http.StatusConflict)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": split.parentID, "value": "8", "expectedRoundVersion": round}, split.member, http.StatusConflict)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": split.parentID, "value": "8", "expectedRoundVersion": fresh}, split.member, http.StatusNoContent)
	if docs = currentStory(splitState(t, srv, id, split.member), split.docs); len(docs["votedUserIds"].([]any)) != 1 {
		t.Fatalf("a delayed vote changed the ended round: %v", docs)
	}
}

func TestPokerUndoSplitLeavesAnUnrelatedRoundAlone(t *testing.T) {
	split := commitSplit(t, "Undo beside a round")
	srv, fac, id := split.srv, split.facilitator, split.sessionID
	flat := addStory(t, srv, id, "Flat", fac)
	selectStory(t, srv, id, flat, fac)
	round := splitState(t, srv, id, fac)["state"].(map[string]any)["roundVersion"]
	splitAction(t, srv, id, "undo-split", split.undoBody(t), fac, http.StatusNoContent)
	state := splitState(t, srv, id, fac)["state"].(map[string]any)
	if state["currentStoryId"] != flat || state["roundVersion"] != round {
		t.Fatalf("undo disturbed another story's round: %v", state)
	}
}
