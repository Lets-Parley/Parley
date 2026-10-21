package poker

import (
	"encoding/json"
	"github.com/lets-parley/parley/internal/session"
	"testing"
)

func TestContinuationCSVRetainsNotesAndDependencies(t *testing.T) {
	parent, points := "parent", "13"
	st := State{Stories: []WireStory{{ID: parent, Title: "Original", Notes: "=formula", Estimate: &points, PlanningRole: "context"}, {ID: "child", ParentID: &parent, Title: "UI", PlanningRole: "planning"}}, Dependencies: []WireDependency{{ID: "edge-b", ParentID: parent, BlockerID: "removed", DependentID: "child", ReviewState: "blocker-removed-review"}, {ID: "edge-a", ParentID: parent, BlockerID: "api", DependentID: "child", ReviewState: "planning"}}}
	rows, err := exportCSV(session.Envelope{State: st})
	if err != nil {
		t.Fatal(err)
	}
	columns := map[string]int{}
	for i, c := range rows[0] {
		columns[c] = i
	}
	notes, ok := columns["notes"]
	if !ok {
		t.Fatal("missing additive notes column")
	}
	dep, ok := columns["dependencies"]
	if !ok {
		t.Fatal("missing additive dependencies column")
	}
	if rows[1][notes] != "'=formula" {
		t.Fatalf("unsafe notes %q", rows[1][notes])
	}
	var edges []WireDependency
	if err := json.Unmarshal([]byte(rows[2][dep]), &edges); err != nil {
		t.Fatal(err)
	}
	if len(edges) != 2 || edges[0].ID != "edge-a" || edges[1].ReviewState != "blocker-removed-review" {
		t.Fatalf("lost or unordered dependencies: %v", edges)
	}
	if rows[1][3] != "13" || rows[2][3] != "" {
		t.Fatalf("changed independent values: %v", rows)
	}
	flat, _ := exportCSV(session.Envelope{State: State{Stories: []WireStory{{ID: "old", Title: "Historical"}}}})
	if len(flat[0]) != 6 {
		t.Fatalf("historical CSV changed: %v", flat)
	}
}
