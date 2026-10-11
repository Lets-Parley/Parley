package publication

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/lets-parley/parley/internal/plugin"
)

func TestGitHubProjectNumericAndBlankReadback(t *testing.T) {
	ctx := context.Background()
	scope := Scope{OrgID: "org", SpaceID: "space", SessionID: "room", PrincipalID: "person"}
	cap := Capability{Verified: true, Generation: "1", Destination: "github:test/repo", IssueType: "ordinary", ParentID: "10", FieldID: "field", Mapping: map[string]string{"3": "3"}}
	cap.ProjectID = "project"
	conn := GitHubConnection{Scope: scope, Capability: cap, Owner: "test", Repository: "repo", Token: "secret", ReadConsent: true, WriteConsent: true}
	p := NewGitHubProvider(func(context.Context, Scope) (GitHubConnection, error) { return conn, nil })
	member := false
	var value *float64
	writes := 0
	mode := ""
	revokeOnRead := false
	p.fetch = func(_ context.Context, r plugin.FetchRequest) (*plugin.FetchResponse, error) {
		var body any
		if r.URL == "https://api.github.com/graphql" {

			if !r.NoRedirect || r.Headers["Authorization"] != "Bearer secret" {
				t.Fatal("unguarded GraphQL request")
			}
			var q struct {
				Query     string
				Variables map[string]any
			}
			json.Unmarshal(r.Body, &q)
			switch {
			case strings.Contains(q.Query, "addProjectV2ItemById"):
				writes++
				member = true
				body = map[string]any{"addProjectV2ItemById": map[string]any{"item": map[string]any{"id": "item"}}}
			case strings.Contains(q.Query, "updateProjectV2ItemFieldValue"):
				writes++
				n := q.Variables["value"].(float64)
				value = &n
				body = map[string]any{"updateProjectV2ItemFieldValue": map[string]any{"projectV2Item": map[string]any{"id": "item"}}}
			default:
				items := []any{}
				if member {
					vals := []any{}
					if value != nil {
						vals = append(vals, map[string]any{"number": *value, "field": map[string]any{"id": "field"}})
					}
					items = append(items, map[string]any{"id": "item", "isArchived": false, "content": map[string]any{"id": "child-node", "number": 11, "repository": map[string]any{"nameWithOwner": "test/repo"}}, "fieldValues": map[string]any{"nodes": vals, "pageInfo": map[string]any{"hasNextPage": false}}})
				}
				body = map[string]any{"node": map[string]any{"id": "project", "closed": false, "viewerCanUpdate": true, "owner": map[string]any{"login": "test"}, "fields": map[string]any{"nodes": []any{map[string]any{"id": "field", "dataType": "NUMBER"}}, "pageInfo": map[string]any{"hasNextPage": false}}, "items": map[string]any{"nodes": items, "pageInfo": map[string]any{"hasNextPage": false}}}}
				node := body.(map[string]any)["node"].(map[string]any)
				switch mode {
				case "owner":
					node["owner"] = map[string]any{"login": "foreign"}
				case "closed":
					node["closed"] = true
				case "permission":
					node["viewerCanUpdate"] = false
				case "fields-page":
					node["fields"].(map[string]any)["pageInfo"] = map[string]any{"hasNextPage": true}
				case "items-page":
					node["items"].(map[string]any)["pageInfo"] = map[string]any{"hasNextPage": true}
				case "field-type":
					node["fields"].(map[string]any)["nodes"] = []any{map[string]any{"id": "field", "dataType": "TEXT"}}
				case "parent":
					node["items"].(map[string]any)["nodes"] = []any{map[string]any{"id": "parent-item", "content": map[string]any{"id": "parent-node", "number": 10, "repository": map[string]any{"nameWithOwner": "test/repo"}}, "fieldValues": map[string]any{"nodes": []any{}, "pageInfo": map[string]any{"hasNextPage": false}}}}
				}
				if revokeOnRead {
					conn.WriteConsent = false
				}

			}
			envelope := map[string]any{"data": body}
			if mode == "graphql-error" {
				envelope["errors"] = []any{map[string]any{"message": "secret provider diagnostic"}}
			}
			encoded, _ := json.Marshal(envelope)
			return &plugin.FetchResponse{Status: 200, Body: encoded}, nil
		}
		if mode == "parent-mismatch" && strings.HasSuffix(r.URL, "/parent") {
			return &plugin.FetchResponse{Status: 404, Body: []byte(`{}`)}, nil
		}
		number := 11
		if strings.HasSuffix(r.URL, "/10") || strings.HasSuffix(r.URL, "/parent") {
			number = 10
		}
		body = map[string]any{"id": number + 1000, "number": number, "node_id": "child-node", "html_url": "https://github.com/test/repo/issues/" + map[int]string{10: "10", 11: "11"}[number]}
		encoded, _ := json.Marshal(body)
		return &plugin.FetchResponse{Status: 200, Body: encoded}, nil
	}
	step := Step{Kind: "estimate", RemoteID: "11", Value: "3", Binding: cap, DispatchAttempt: 1}
	o, err := p.Inspect(ctx, scope, step)
	if err != nil || !o.Known || o.Matches || !o.MutationAllowed {
		t.Fatalf("unset baseline %#v %v", o, err)
	}
	membership := step
	membership.Kind = "project"
	membership.Value = ""
	out, err := p.Apply(ctx, scope, membership)
	if err != nil || out != Unknown || writes != 1 {
		t.Fatalf("membership write %s %v writes%d", out, err, writes)
	}
	observed, _ := p.Inspect(ctx, scope, membership)
	if !observed.Known || !observed.Matches {
		t.Fatal("membership not read back")
	}
	out, err = p.Apply(ctx, scope, step)
	if err != nil || out != Unknown || writes != 2 {
		t.Fatalf("numeric write %s %v writes%d", out, err, writes)
	}
	o, err = p.Inspect(ctx, scope, step)
	if err != nil || !o.Known || !o.Matches {
		t.Fatalf("numeric readback %#v %v", o, err)
	}
	step.Value = ""
	o, _ = p.Inspect(ctx, scope, step)
	if o.Matches || o.MutationAllowed {
		t.Fatal("blank overwrote numeric upstream")
	}
	value = nil
	o, _ = p.Inspect(ctx, scope, step)
	if !o.Known || !o.Matches {
		t.Fatalf("blank readback %#v", o)
	}
	step.Value = "3"
	step.DispatchAttempt = 2
	o, _ = p.Inspect(ctx, scope, step)
	if o.Known || o.MutationAllowed {
		t.Fatalf("unknown retry %#v", o)
	}
	for _, bad := range []string{"owner", "closed", "permission", "fields-page", "items-page", "field-type", "parent", "graphql-error", "parent-mismatch"} {
		t.Run(bad, func(t *testing.T) {
			mode = bad
			step.DispatchAttempt = 1
			if bad == "parent" {
				control := conn
				control.Capability.ParentID = "12"
				if _, err := p.project(ctx, control); err != nil {
					t.Fatal("parent fixture rejected beyond parent exclusion")
				}
			}
			o, err := p.Inspect(ctx, scope, step)
			if err == nil && (o.Known || o.MutationAllowed) {
				t.Fatalf("drift authorized %#v", o)
			}
			before := writes
			p.Apply(ctx, scope, step)
			if writes != before {
				t.Fatal("drift wrote")
			}
			_, err = p.Capability(ctx, scope)
			if err == nil && bad != "parent-mismatch" {
				t.Fatal("drift verified capability")
			}
		})
	}
	mode = ""
	step.DispatchAttempt = 1
	step.Value = "999"
	o, _ = p.Inspect(ctx, scope, step)
	if o.Known || o.MutationAllowed {
		t.Fatal("unmapped value authorized")
	}
	step.Value = "3"
	conn.WriteConsent = true
	revokeOnRead = true
	before := writes
	p.Apply(ctx, scope, step)
	if writes != before {
		t.Fatal("late revoke wrote")
	}
	revokeOnRead = false
	conn.WriteConsent = true
	n := 5.0
	value = &n
	before = writes
	o, _ = p.Inspect(ctx, scope, step)
	p.Apply(ctx, scope, step)
	if o.Known || o.MutationAllowed || writes != before {
		t.Fatal("upstream default overwritten")
	}

}

func TestGitHubProjectMembershipHasIndependentReceipt(t *testing.T) {
	e, s, r, f := fixture(t)
	f.cap.ProjectID = "project"
	review := approve(t, e, s, r)
	count := 0
	for _, step := range review.Steps {
		if step.Kind == "project" {
			count++
			if step.TargetKey == "" || step.Binding.ProjectID != "project" {
				t.Fatal("unbound membership")
			}
		}
	}
	if count != 3 {
		t.Fatalf("project receipts %d, want three independent of estimates", count)
	}
	if err := e.Run(context.Background(), s, review.ID); err != nil {
		t.Fatal(err)
	}
	receipts, err := e.Receipts(context.Background(), s, review.ID)
	if err != nil {
		t.Fatal(err)
	}
	count = 0
	for _, receipt := range receipts {
		if receipt.Kind == "project" && receipt.State == Confirmed {
			count++
		}
	}
	if count != 3 {
		t.Fatalf("confirmed project receipts %d", count)
	}
}

func TestGitHubPartialMembershipWaits(t *testing.T) {
	e, s, r, f := fixture(t)
	f.cap.ProjectID = "project"
	review := approve(t, e, s, r)
	var project, estimate Step
	for _, step := range review.Steps {
		if step.ChildID == r.Children[0] {
			if step.Kind == "project" {
				project = step
			}
			if step.Kind == "estimate" {
				estimate = step
			}
		}
	}
	f.ambiguous[project.Key] = true
	if err := e.Run(context.Background(), s, review.ID); err != nil {
		t.Fatal(err)
	}
	if f.calls[estimate.Key] != 0 {
		t.Fatal("estimate dispatched before membership receipt")
	}
	receipts, err := e.Receipts(context.Background(), s, review.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range receipts {
		if receipt.Key == estimate.Key && receipt.State != Waiting {
			t.Fatalf("estimate state %s", receipt.State)
		}
	}
	var confirmed Step
	for _, step := range review.Steps {
		if step.Kind == "project" && step.ChildID != project.ChildID {
			confirmed = step
			break
		}
	}
	before := f.calls[confirmed.Key]
	f.ambiguous[project.Key] = false
	f.remote[project.Key] = "member"
	if err := e.Run(context.Background(), s, review.ID); err != nil {
		t.Fatal(err)
	}
	if f.calls[confirmed.Key] != before || f.calls[estimate.Key] != 1 {
		t.Fatal("partial retry repeated successful membership or lost estimate")
	}
}

func TestGitHubProjectReadOnlyReconciliation(t *testing.T) {
	e, s, r, f := fixture(t)
	f.cap.ProjectID = "project"
	review := approve(t, e, s, r)
	project := stepOf(t, review, "project", 0)
	f.ambiguous[project.Key] = true
	if err := e.Run(context.Background(), s, review.ID); err != nil {
		t.Fatal(err)
	}
	f.ambiguous[project.Key] = false
	f.remote[project.Key] = "member"
	f.onInspect = func(step Step) {
		if step.Kind == "project" && step.RemoteID == "" {
			t.Fatal("membership reconciliation lost exact child identity")
		}
	}
	if err := e.Verify(context.Background(), s, review.ID); err != nil {
		t.Fatal(err)
	}
	receipts, err := e.Receipts(context.Background(), s, review.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range receipts {
		if receipt.Key == project.Key && receipt.State != Confirmed {
			t.Fatalf("membership reconciliation %s", receipt.State)
		}
	}
	if f.calls[project.Key] != 0 {
		t.Fatal("read-only verification wrote membership")
	}
}
