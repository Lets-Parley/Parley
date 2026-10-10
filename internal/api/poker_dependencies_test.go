package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestPokerSiblingDependenciesPersist(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, _, id := setupSession(t, srv, "Dependencies")
	p := addStory(t, srv, id, "Parent", fac)
	a := draftChild(t, srv, id, p, "API", "api", 0, fac)
	b := draftChild(t, srv, id, p, "UI", "ui", 1, fac)
	c := draftChild(t, srv, id, p, "Permissions", "permissions", 2, fac)
	proposal := map[string]any{"parentId": p, "expectedDependencyRevision": 0, "expectedRevision": 0, "children": map[string]int{a: 0, b: 0, c: 0}, "edges": []map[string]string{{"blockerId": a, "dependentId": b}, {"blockerId": c, "dependentId": b}}}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNoContent)
	env := splitState(t, srv, id, fac)
	state := env["state"].(map[string]any)
	edges := state["dependencies"].([]any)
	if len(edges) != 2 {
		t.Fatalf("edges: %v", edges)
	}
	if state["dependencyNotice"] != "Planning dependency · Completion not checked" {
		t.Fatalf("notice: %v", state)
	}
	if state["roundVersion"] != float64(0) || state["currentStoryId"] != nil {
		t.Fatalf("dependencies changed round: %v", state)
	}
	if currentStory(env, p)["dependencyRevision"] != float64(1) {
		t.Fatal("graph revision did not advance")
	}
}

func TestPokerDependenciesRemovedBlockerAndUnsafeUndo(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, _, id := setupSession(t, srv, "Undo dependencies")
	p := addStory(t, srv, id, "Parent", fac)
	a := draftChild(t, srv, id, p, "API", "a", 0, fac)
	b := draftChild(t, srv, id, p, "UI", "b", 1, fac)
	c := draftChild(t, srv, id, p, "Permissions", "c", 2, fac)
	proposal := map[string]any{"parentId": p, "expectedDependencyRevision": 0, "expectedRevision": 0, "children": map[string]int{a: 0, b: 0, c: 0}, "edges": []map[string]string{{"blockerId": a, "dependentId": b}}}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNoContent)
	edges := splitState(t, srv, id, fac)["state"].(map[string]any)["dependencies"].([]any)
	edgeID := edges[0].(map[string]any)["id"].(string)
	removal := map[string]any{"storyId": a, "expectedRevision": 0, "expectedSplitRevision": 3}
	splitAction(t, srv, id, "remove-child", removal, fac, http.StatusConflict)
	removal["expectedDependencyRevision"] = 1
	removal["affectedDependencies"] = []string{edgeID}
	splitAction(t, srv, id, "remove-child", removal, fac, http.StatusNoContent)
	if edge := splitState(t, srv, id, fac)["state"].(map[string]any)["dependencies"].([]any)[0].(map[string]any); edge["reviewState"] != "blocker-removed-review" {
		t.Fatalf("removed blocker: %v", edge)
	}
	proposal["expectedDependencyRevision"] = 2
	proposal["children"] = map[string]int{a: 1, b: 0, c: 0}
	proposal["edges"] = []map[string]string{{"blockerId": b, "dependentId": c}}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNoContent)
	// A second removal and restoration preserve intent through the retained graph.
	restore := map[string]any{"storyId": a, "expectedRevision": 1, "expectedSplitRevision": 4, "expectedDependencyRevision": 3}
	splitAction(t, srv, id, "restore-child", restore, fac, http.StatusNoContent)
	edges = splitState(t, srv, id, fac)["state"].(map[string]any)["dependencies"].([]any)
	if len(edges) != 2 {
		t.Fatalf("Undo lost edge: %v", edges)
	}
	for _, raw := range edges {
		edge := raw.(map[string]any)
		if edge["reviewState"] != "planning" {
			t.Fatalf("safe restore: %v", edge)
		}
	}
}

func TestPokerDependenciesRejectCyclesAndStaleContent(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, id := setupSession(t, srv, "DAG guards")
	p := addStory(t, srv, id, "Parent", fac)
	a := draftChild(t, srv, id, p, "API", "a", 0, fac)
	b := draftChild(t, srv, id, p, "UI", "b", 1, fac)
	c := draftChild(t, srv, id, p, "Permissions", "c", 2, fac)
	d := draftChild(t, srv, id, p, "API", "d", 3, fac)
	pair := func(a, b string) map[string]string { return map[string]string{"blockerId": a, "dependentId": b} }
	proposal := map[string]any{"parentId": p, "expectedRevision": 0, "expectedDependencyRevision": 0, "children": map[string]int{a: 0, b: 0, c: 0, d: 0}, "edges": []map[string]string{}}
	for _, edges := range [][]map[string]string{{pair(a, a)}, {pair(a, b), pair(a, b)}, {pair(a, b), pair(b, a)}, {pair(a, b), pair(b, c), pair(c, d), pair(d, a)}} {
		proposal["edges"] = edges
		out := splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusConflict)
		if len(edges) == 4 && !strings.Contains(out["error"].(string), "API → UI → Permissions → API → API") {
			t.Fatalf("named cycle: %v", out)
		}
		if len(splitState(t, srv, id, fac)["state"].(map[string]any)["dependencies"].([]any)) != 0 {
			t.Fatal("partial graph committed")
		}
	}
	proposal["edges"] = []map[string]string{pair(a, b)}
	splitAction(t, srv, id, "dependencies", proposal, member, http.StatusForbidden)
	otherParent := addStory(t, srv, id, "Other", fac)
	foreign := draftChild(t, srv, id, otherParent, "Other sibling", "foreign", 0, fac)
	proposal["edges"] = []map[string]string{pair(a, foreign)}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusConflict)
	otherFac, _, otherSession := setupSession(t, srv, "Foreign tenant room")
	foreignParent := addStory(t, srv, otherSession, "Foreign parent", otherFac)
	foreignChild := draftChild(t, srv, otherSession, foreignParent, "Foreign child", "tenant-child", 0, otherFac)
	var otherOrg string
	if err := pool.QueryRow(context.Background(), "insert into orgs(slug,name,claim_value) values('foreign-dependencies','Foreign','foreign-dependencies') returning id::text").Scan(&otherOrg); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), "update spaces set org_id=$2 where id=(select space_id from sessions where id=$1)", otherSession, otherOrg); err != nil {
		t.Fatal(err)
	}
	proposal["edges"] = []map[string]string{pair(a, foreignChild)}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusConflict)
	proposal["parentId"] = foreignParent
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNotFound)
	proposal["parentId"] = p
	proposal["edges"] = []map[string]string{pair(a, b)}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNoContent)
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusConflict)
	if resp := patchStory(t, srv, id, a, `"title":"Renamed API","expectedRevision":0`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatal(resp.StatusCode)
	}
	proposal["expectedDependencyRevision"] = 1
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusConflict)
	proposal["children"] = map[string]int{a: 1, b: 0, c: 0, d: 0}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNoContent)
	if resp := patchStory(t, srv, id, p, `"notes":"Parent reviewed content","expectedRevision":0`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatal(resp.StatusCode)
	}
	proposal["expectedDependencyRevision"] = 2
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusConflict)
	proposal["expectedRevision"] = 1
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNoContent)
	edges := splitState(t, srv, id, fac)["state"].(map[string]any)["dependencies"].([]any)
	if len(edges) != 1 || edges[0].(map[string]any)["blockerId"] != a {
		t.Fatalf("rename lost identity: %v", edges)
	}
}

func TestPokerDependenciesUnsafeRestorationNeedsReview(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, _, id := setupSession(t, srv, "Unsafe Undo")
	p := addStory(t, srv, id, "Parent", fac)
	a := draftChild(t, srv, id, p, "A", "a", 0, fac)
	b := draftChild(t, srv, id, p, "B", "b", 1, fac)
	c := draftChild(t, srv, id, p, "C", "c", 2, fac)
	proposal := map[string]any{"parentId": p, "expectedRevision": 0, "expectedDependencyRevision": 0, "children": map[string]int{a: 0, b: 0, c: 0}, "edges": []map[string]string{{"blockerId": a, "dependentId": b}, {"blockerId": c, "dependentId": a}}}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNoContent)
	edges := splitState(t, srv, id, fac)["state"].(map[string]any)["dependencies"].([]any)
	ids := []string{}
	for _, raw := range edges {
		ids = append(ids, raw.(map[string]any)["id"].(string))
	}
	splitAction(t, srv, id, "remove-child", map[string]any{"storyId": a, "expectedRevision": 0, "expectedSplitRevision": 3, "expectedDependencyRevision": 1, "affectedDependencies": ids}, fac, http.StatusNoContent)
	proposal["expectedDependencyRevision"] = 2
	proposal["children"] = map[string]int{a: 1, b: 0, c: 0}
	proposal["edges"] = []map[string]string{{"blockerId": b, "dependentId": c}}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNoContent)
	splitAction(t, srv, id, "restore-child", map[string]any{"storyId": a, "expectedRevision": 1, "expectedSplitRevision": 4, "expectedDependencyRevision": 3}, fac, http.StatusNoContent)
	edges = splitState(t, srv, id, fac)["state"].(map[string]any)["dependencies"].([]any)
	if len(edges) != 3 {
		t.Fatalf("lost intent: %v", edges)
	}
	for _, raw := range edges {
		e := raw.(map[string]any)
		want := "review-needed"
		if e["blockerId"] == b {
			want = "planning"
		}
		if e["reviewState"] != want {
			t.Fatalf("unsafe restoration: %v", e)
		}
	}
}

func TestPokerDependenciesOpposingSavesPreserveRounds(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, id := setupSession(t, srv, "Opposing tabs")
	p := addStory(t, srv, id, "Parent", fac)
	a := draftChild(t, srv, id, p, "API", "a", 0, fac)
	b := draftChild(t, srv, id, p, "UI", "b", 1, fac)
	splitAction(t, srv, id, "adopt", map[string]any{"parentId": p, "expectedRevision": 0, "expectedSplitRevision": 2, "children": map[string]int{a: 0, b: 0}, "coverage": "full"}, fac, http.StatusNoContent)
	if resp := patchStory(t, srv, id, a, `"estimate":"3","expectedRevision":1`, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatal(resp.StatusCode)
	}
	splitAction(t, srv, id, "select", map[string]any{"storyId": b}, fac, http.StatusNoContent)
	roundEnv := splitState(t, srv, id, member)
	splitAction(t, srv, id, "vote", map[string]any{"storyId": b, "value": "5", "expectedRoundVersion": roundEnv["state"].(map[string]any)["roundVersion"]}, member, http.StatusNoContent)
	before := splitState(t, srv, id, fac)
	proposal := map[string]any{"parentId": p, "expectedRevision": 1, "expectedDependencyRevision": 0, "children": map[string]int{a: 2, b: 1}}
	statuses := concurrentStatuses(t, 2, func(i int) (int, error) {
		body := map[string]any{}
		for k, v := range proposal {
			body[k] = v
		}
		blocker, dependent := a, b
		if i == 1 {
			blocker, dependent = b, a
		}
		body["edges"] = []map[string]string{{"blockerId": blocker, "dependentId": dependent}}
		raw, _ := json.Marshal(body)
		return requestStatus(srv, http.MethodPost, "/api/sessions/"+id+"/actions/dependencies", string(raw), fac)
	})
	requireStatuses(t, statuses, http.StatusNoContent, http.StatusConflict, 1)
	after := splitState(t, srv, id, member)
	stateBefore := before["state"].(map[string]any)
	stateAfter := after["state"].(map[string]any)
	for _, key := range []string{"currentStoryId", "roundVersion"} {
		if stateBefore[key] != stateAfter[key] {
			t.Fatalf("dependency write changed %s", key)
		}
	}
	for _, storyID := range []string{p, a, b} {
		left := currentStory(before, storyID)
		right := currentStory(after, storyID)
		for _, key := range []string{"parentId", "planningRole", "position", "estimate", "contentRevision", "status", "scopeRevision", "acceptedScopeRevision", "acceptedRoundVersion", "estimateProvenance", "estimateNeedsReview"} {
			if left[key] != right[key] {
				t.Fatalf("dependency changed %s: %v -> %v", key, left, right)
			}
		}
		if _, ok := right["votes"]; ok {
			t.Fatal("hidden votes disclosed")
		}
	}
	var count int
	var value string
	if err := pool.QueryRow(context.Background(), "select count(*),max(value) from votes where story_id=$1", b).Scan(&count, &value); err != nil || count != 1 || value != "5" {
		t.Fatalf("vote changed: %d %s %v", count, value, err)
	}
	// Retiring the only active edge changes no meeting state and keeps its receipt.
	proposal["expectedDependencyRevision"] = 1
	proposal["edges"] = []map[string]string{}
	splitAction(t, srv, id, "dependencies", proposal, fac, http.StatusNoContent)
	edge := splitState(t, srv, id, fac)["state"].(map[string]any)["dependencies"].([]any)[0].(map[string]any)
	if edge["reviewState"] != "retired" || edge["retiredAt"] == nil {
		t.Fatalf("retired intent: %v", edge)
	}
}

func TestPokerDependenciesRecheckAuthorityAfterLock(t *testing.T) {
	for _, change := range []string{"facilitator", "membership", "org-revoked", "ended"} {
		t.Run(change, func(t *testing.T) {
			pool := testPool(t)
			srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
			fac, member, id := setupSession(t, srv, "Delayed graph")
			p := addStory(t, srv, id, "Parent", fac)
			a := draftChild(t, srv, id, p, "A", "a", 0, fac)
			b := draftChild(t, srv, id, p, "B", "b", 1, fac)
			tx, err := pool.Begin(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err := tx.Exec(context.Background(), "select id from sessions where id=$1 for update", id); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(map[string]any{"parentId": p, "expectedRevision": 0, "expectedDependencyRevision": 0, "children": map[string]int{a: 0, b: 0}, "edges": []map[string]string{{"blockerId": a, "dependentId": b}}})
			result := delayedJSONRequest(srv, http.MethodPost, "/api/sessions/"+id+"/actions/dependencies", string(raw), fac)
			waitForBlockedMutation(t, pool, result)
			want := http.StatusForbidden
			switch change {
			case "facilitator":
				_, who := doJSON(t, srv, http.MethodGet, "/api/me", "", member)
				_, err = tx.Exec(context.Background(), "update sessions set facilitator_id=$2 where id=$1", id, who["id"])
			case "membership":
				want = http.StatusNotFound
				_, err = tx.Exec(context.Background(), "delete from members where space_id=(select space_id from sessions where id=$1) and user_id=(select facilitator_id from sessions where id=$1)", id)
			case "org-revoked":
				want = http.StatusNotFound
				_, err = tx.Exec(context.Background(), "update org_members set revoked_at=now() where user_id=(select facilitator_id from sessions where id=$1)", id)
			case "ended":
				want = http.StatusConflict
				_, err = tx.Exec(context.Background(), "update sessions set ended_at=now() where id=$1", id)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(context.Background()); err != nil {
				t.Fatal(err)
			}
			if status := <-result; status != want {
				t.Fatalf("delayed graph: %d want %d", status, want)
			}
			var count int
			if err := pool.QueryRow(context.Background(), "select count(*) from poker_dependencies where session_id=$1", id).Scan(&count); err != nil || count != 0 {
				t.Fatalf("unauthorized graph persisted: %d %v", count, err)
			}
		})
	}
}
