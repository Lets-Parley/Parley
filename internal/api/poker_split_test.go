package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func splitAction(t *testing.T, srv *httptest.Server, sessionID, action string, body any, cookie *http.Cookie, want int) map[string]any {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	resp, out := doJSON(t, srv, http.MethodPost, "/api/sessions/"+sessionID+"/actions/"+action, string(raw), cookie)
	if resp.StatusCode != want {
		t.Fatalf("%s: status %d, want %d; body %v", action, resp.StatusCode, want, out)
	}
	return out
}

func draftChild(t *testing.T, srv *httptest.Server, sessionID, parentID, title, operation string, revision int, cookie *http.Cookie) string {
	t.Helper()
	out := splitAction(t, srv, sessionID, "child", map[string]any{"parentId": parentID, "title": title, "operationId": operation, "expectedSplitRevision": revision}, cookie, http.StatusCreated)
	return out["storyId"].(string)
}

func splitState(t *testing.T, srv *httptest.Server, id string, cookie *http.Cookie) map[string]any {
	t.Helper()
	resp, env := doJSON(t, srv, http.MethodGet, "/api/sessions/"+id, "", cookie)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("state: %d", resp.StatusCode)
	}
	return env
}

func TestPokerSplitDraftReplayAndAdoption(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, _, id := setupSession(t, srv, "Split room")
	parent := addStory(t, srv, id, "Original scope", fac)
	if resp := patchStory(t, srv, id, parent, `"estimate":"13","notes":"Parent notes"`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatal(resp.StatusCode)
	}
	c1 := draftChild(t, srv, id, parent, "API", "operation-api", 0, fac)
	body := map[string]any{"parentId": parent, "title": "API", "operationId": "operation-api", "expectedSplitRevision": 0}
	replay := splitAction(t, srv, id, "child", body, fac, http.StatusOK)
	if replay["storyId"] != c1 {
		t.Fatalf("replay changed identity: %v", replay)
	}
	body["title"] = "Different content"
	splitAction(t, srv, id, "child", body, fac, http.StatusConflict)
	c2 := draftChild(t, srv, id, parent, "UI", "operation-ui", 1, fac)
	c3 := draftChild(t, srv, id, parent, "Permissions", "operation-perms", 2, fac)
	env := splitState(t, srv, id, fac)
	if s := currentStory(env, c1); s["planningRole"] != "proposed" || s["notes"] != "" {
		t.Fatalf("draft: %v", s)
	}
	if s := currentStory(env, parent); s["planningRole"] != "planning" || s["estimate"] != "13" {
		t.Fatalf("draft changed parent: %v", s)
	}
	if env["state"].(map[string]any)["roundVersion"] != float64(0) {
		t.Fatal("draft started a round")
	}
	for i, c := range []string{c1, c2} {
		if resp := patchStory(t, srv, id, c, fmt.Sprintf(`"estimate":%q,"expectedRevision":0`, []string{"3", "5"}[i]), fac); resp.StatusCode != http.StatusNoContent {
			t.Fatal(resp.StatusCode)
		}
	}
	adopt := map[string]any{"parentId": parent, "expectedSplitRevision": 3, "expectedRevision": 1, "coverage": "full", "children": map[string]int{c1: 1, c2: 1, c3: 0}}
	splitAction(t, srv, id, "adopt", adopt, fac, http.StatusNoContent)
	env = splitState(t, srv, id, fac)
	if s := currentStory(env, parent); s["planningRole"] != "context" || s["estimate"] != "13" || s["notes"] != "Parent notes" {
		t.Fatalf("parent history: %v", s)
	}
	for i, c := range []string{c1, c2, c3} {
		s := currentStory(env, c)
		if s["planningRole"] != "planning" || s["estimate"] != []any{"3", "5", nil}[i] {
			t.Fatalf("child identity/estimate: %v", s)
		}
	}
	progress := fieldJSON(t, spaceSessionRows(t, srv, spaceSlugOf(t, srv, id, fac), fac)[id], "progress")
	if progress != `{"kind":"poker","settled":2,"total":3}` {
		t.Fatalf("adopted progress: %s", progress)
	}
	if resp := patchStory(t, srv, id, parent, `"estimate":"8","expectedRevision":2`, fac); resp.StatusCode != http.StatusConflict {
		t.Fatalf("context estimate overwritten: %d", resp.StatusCode)
	}
	resp, _ := doJSON(t, srv, http.MethodPost, "/api/sessions/"+id+"/actions/select", `{"storyId":"`+parent+`"}`, fac)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("dealt context: %d", resp.StatusCode)
	}
}

func TestPokerSplitConflictsMinimumAndUndo(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Split conflicts")
	p := addStory(t, srv, id, "Parent", fac)
	c1 := draftChild(t, srv, id, p, "One", "one", 0, fac)
	adopt := map[string]any{"parentId": p, "expectedSplitRevision": 1, "expectedRevision": 0, "coverage": "full", "children": map[string]int{c1: 0}}
	splitAction(t, srv, id, "adopt", adopt, fac, http.StatusConflict)
	c2 := draftChild(t, srv, id, p, "Two", "two", 1, fac)
	if resp := patchStory(t, srv, id, c1, `"title":"Mine","expectedRevision":0`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatal(resp.StatusCode)
	}
	if resp := patchStory(t, srv, id, c1, `"title":"Stale","expectedRevision":0`, fac); resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale child: %d", resp.StatusCode)
	}
	if resp := patchStory(t, srv, id, c2, `"title":"Independent","expectedRevision":0`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("independent child: %d", resp.StatusCode)
	}
	adopt["expectedSplitRevision"] = 2
	adopt["children"] = map[string]int{c1: 0, c2: 1}
	splitAction(t, srv, id, "adopt", adopt, fac, http.StatusConflict)
	adopt["children"] = map[string]int{c1: 1, c2: 1}
	adopt["coverage"] = "remainder"
	splitAction(t, srv, id, "adopt", adopt, fac, http.StatusBadRequest)
	adopt["remainderId"] = c2
	splitAction(t, srv, id, "adopt", adopt, fac, http.StatusNoContent)
	splitAction(t, srv, id, "remove-child", map[string]any{"storyId": c1, "expectedRevision": 2, "expectedSplitRevision": 3}, fac, http.StatusConflict)
	c3 := draftChild(t, srv, id, p, "Third", "third", 3, fac)
	splitAction(t, srv, id, "remove-child", map[string]any{"storyId": c3, "expectedRevision": 0, "expectedSplitRevision": 4}, fac, http.StatusNoContent)
	splitAction(t, srv, id, "restore-child", map[string]any{"storyId": c3, "expectedRevision": 1, "expectedSplitRevision": 5}, fac, http.StatusNoContent)
	s := currentStory(splitState(t, srv, id, fac), c3)
	if s["title"] != "Third" || s["removedAt"] != nil || s["planningRole"] != "proposed" {
		t.Fatalf("undo: %v", s)
	}
}

func TestPokerSplitAuthorityAndBounds(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, id := setupSession(t, srv, "Split authority")
	p := addStory(t, srv, id, "Parent", fac)
	create := map[string]any{"parentId": p, "title": "Draft", "operationId": "draft", "expectedSplitRevision": 0}
	splitAction(t, srv, id, "child", create, member, http.StatusForbidden)
	outsider := signup(t, srv, "Outsider")
	splitAction(t, srv, id, "child", create, outsider, http.StatusNotFound)
	c := draftChild(t, srv, id, p, "Child", "draft", 0, fac)
	create["parentId"] = c
	create["operationId"] = "nested"
	splitAction(t, srv, id, "child", create, fac, http.StatusConflict)
	_, _, other := setupSession(t, srv, "Other tenant space")
	splitAction(t, srv, other, "child", create, fac, http.StatusNotFound)
	create["parentId"] = p
	create["operationId"] = "late"
	create["expectedSplitRevision"] = 1
	if _, err := pool.Exec(context.Background(), "update sessions set ended_at=now() where id=$1", id); err != nil {
		t.Fatal(err)
	}
	splitAction(t, srv, id, "child", create, fac, http.StatusConflict)
	if _, err := pool.Exec(context.Background(), "update sessions set ended_at=null where id=$1", id); err != nil {
		t.Fatal(err)
	}
	for i := 1; i < 10; i++ {
		draftChild(t, srv, id, p, fmt.Sprint(i), fmt.Sprint("op", i), i, fac)
	}
	create["expectedSplitRevision"] = 10
	splitAction(t, srv, id, "child", create, fac, http.StatusConflict)
	if len(splitState(t, srv, id, fac)["state"].(map[string]any)["stories"].([]any)) != 11 {
		t.Fatal("cap wrote a child")
	}
}

func TestPokerSplitCSVRetainsIdentityAndPreviousEstimate(t *testing.T) {
	srv := testServer(t)
	fac, member, id := setupSession(t, srv, "Split CSV")
	p := addStory(t, srv, id, "Original", fac)
	patchStory(t, srv, id, p, `"estimate":"13"`, fac)
	children := []string{}
	for i, title := range []string{"API", "UI", "Permissions"} {
		children = append(children, draftChild(t, srv, id, p, title, title, i, fac))
	}
	patchStory(t, srv, id, children[0], `"estimate":"3","expectedRevision":0`, fac)
	patchStory(t, srv, id, children[1], `"estimate":"5","expectedRevision":0`, fac)
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": p, "expectedSplitRevision": 3, "expectedRevision": 1, "coverage": "full", "children": map[string]int{children[0]: 1, children[1]: 1, children[2]: 0}}, fac, http.StatusNoContent)
	resp, body := fetchCSV(t, srv, id, member)
	if resp.StatusCode != http.StatusOK {
		t.Fatal(resp.StatusCode)
	}
	rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 5 || len(rows[0]) != 13 {
		t.Fatalf("split CSV needs role/identity metadata:\n%s", body)
	}
	for i, row := range rows[1:] {
		if i == 0 {
			if row[3] != "13" || row[6] != p || row[8] != "context" {
				t.Fatalf("previous parent estimate: %v", row)
			}
			continue
		}
		if row[6] != children[i-1] || row[7] != p || row[8] != "planning" || row[3] != []string{"3", "5", ""}[i-1] {
			t.Fatalf("independent child: %v", row)
		}
	}
}

func TestPokerSplitConcurrentCreationAndQuota(t *testing.T) {
	srv, _ := quotaServer(t, Limits{StoriesPerSession: 2})
	fac, _, id := setupSession(t, srv, "Split quota")
	p := addStory(t, srv, id, "Parent", fac)
	body := fmt.Sprintf(`{"parentId":%q,"title":"One","operationId":"same","expectedSplitRevision":0}`, p)
	statuses := concurrentStatuses(t, 2, func(_ int) (int, error) {
		return requestStatus(srv, http.MethodPost, "/api/sessions/"+id+"/actions/child", body, fac)
	})
	requireStatuses(t, statuses, http.StatusCreated, http.StatusOK, 1)
	splitAction(t, srv, id, "child", map[string]any{"parentId": p, "title": "Kept typed text", "operationId": "next", "expectedSplitRevision": 1}, fac, http.StatusConflict)
	if len(splitState(t, srv, id, fac)["state"].(map[string]any)["stories"].([]any)) != 2 {
		t.Fatal("quota inserted an extra child")
	}
}

func TestPokerSplitRechecksAuthorityAfterLock(t *testing.T) {
	for _, change := range []string{"facilitator", "membership", "ended"} {
		t.Run(change, func(t *testing.T) {
			pool := testPool(t)
			srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
			fac, member, id := setupSession(t, srv, "Delayed split")
			p := addStory(t, srv, id, "Parent", fac)
			_, who := doJSON(t, srv, http.MethodGet, "/api/me", "", member)
			tx, err := pool.Begin(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(context.Background(), "select id from sessions where id=$1 for update", id); err != nil {
				t.Fatal(err)
			}
			result := delayedJSONRequest(srv, http.MethodPost, "/api/sessions/"+id+"/actions/child", fmt.Sprintf(`{"parentId":%q,"title":"Delayed","operationId":"delayed","expectedSplitRevision":0}`, p), fac)
			waitForBlockedMutation(t, pool, result)
			want := http.StatusForbidden
			var q string
			switch change {
			case "facilitator":
				q = "update sessions set facilitator_id=$2 where id=$1"
			case "membership":
				q = "delete from members where space_id=(select space_id from sessions where id=$1) and user_id=(select facilitator_id from sessions where id=$1)"
				want = http.StatusNotFound
			case "ended":
				q = "update sessions set ended_at=now() where id=$1"
				want = http.StatusConflict
			}
			if change == "facilitator" {
				_, err = tx.Exec(context.Background(), q, id, who["id"])
			} else {
				_, err = tx.Exec(context.Background(), q, id)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(context.Background()); err != nil {
				t.Fatal(err)
			}
			if status := <-result; status != want {
				t.Fatalf("delayed mutation: %d want %d", status, want)
			}
			var count int
			if err := pool.QueryRow(context.Background(), "select count(*) from stories where session_id=$1", id).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 1 {
				t.Fatal("delayed unauthorized write persisted")
			}
		})
	}
}

func TestPokerSplitRemovalRetainsEstimateAndRequiresCoverageReview(t *testing.T) {
	srv := testServer(t)
	fac, _, id := setupSession(t, srv, "Split retirement")
	p := addStory(t, srv, id, "Parent", fac)
	children := []string{}
	reviewed := map[string]int{}
	for i, title := range []string{"One", "Two", "Three"} {
		c := draftChild(t, srv, id, p, title, title, i, fac)
		children = append(children, c)
		reviewed[c] = 0
	}
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": p, "expectedRevision": 0, "expectedSplitRevision": 3, "coverage": "full", "children": reviewed}, fac, http.StatusNoContent)
	c := children[0]
	if resp := patchStory(t, srv, id, c, `"estimate":"3","notes":"Saved child notes","expectedRevision":1`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatal(resp.StatusCode)
	}
	splitAction(t, srv, id, "remove-child", map[string]any{"storyId": c, "expectedRevision": 2, "expectedSplitRevision": 4}, fac, http.StatusNoContent)
	env := splitState(t, srv, id, fac)
	if s := currentStory(env, c); s["removedAt"] == nil || s["estimate"] != "3" || s["notes"] != "Saved child notes" {
		t.Fatalf("retained child: %v", s)
	}
	if s := currentStory(env, p); s["planningRole"] != "context" || s["coverage"] != "needs-review" {
		t.Fatalf("removal silently revived parent or coverage: %v", s)
	}
	splitAction(t, srv, id, "restore-child", map[string]any{"storyId": c, "expectedRevision": 3, "expectedSplitRevision": 5}, fac, http.StatusNoContent)
	if s := currentStory(splitState(t, srv, id, fac), c); s["removedAt"] != nil || s["estimate"] != "3" || s["notes"] != "Saved child notes" || s["planningRole"] != "planning" {
		t.Fatalf("restored child: %v", s)
	}
}

func TestPokerSplitEmbeddedAuthorityParity(t *testing.T) {
	srv := embedServer(t, testPool(t))
	fac, member, id := setupSession(t, srv, "Embedded split")
	p := addStory(t, srv, id, "Parent", fac)
	memberToken := embedToken(t, srv, member)
	for _, name := range []string{"child", "adopt", "remove-child", "restore-child"} {
		if got := bearerStatus(t, srv, http.MethodPost, "/api/sessions/"+id+"/actions/"+name, "{}", memberToken); got != http.StatusForbidden {
			t.Fatalf("embedded participant %s: %d", name, got)
		}
	}
	facToken := embedToken(t, srv, fac)
	body := fmt.Sprintf(`{"parentId":%q,"title":"Child","operationId":"embedded","expectedSplitRevision":0}`, p)
	if got := bearerStatus(t, srv, http.MethodPost, "/api/sessions/"+id+"/actions/child", body, facToken); got != http.StatusCreated {
		t.Fatalf("embedded facilitator parity: %d", got)
	}
}
