package publication

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/lets-parley/parley/internal/plugin"
	"strconv"
	"strings"
	"testing"
)

func TestGitHubReviewedBodyAndDurableAttempt(t *testing.T) {
	e, s, r, f := fixture(t)
	v := approve(t, e, s, r)
	step := stepOf(t, v, "create", 0)
	raw, _ := json.Marshal(step)
	var payload map[string]any
	json.Unmarshal(raw, &payload)
	want := step.Notes + "\n\n<!-- parley-publication:" + step.Key + " -->"
	if payload["body"] != want {
		t.Fatalf("reviewed create body = %v; want %q", payload["body"], want)
	}
	var seen []int
	f.onInspect = func(step Step) {
		if step.Kind == "create" {
			seen = append(seen, step.DispatchAttempt)
		}
	}
	if err := e.Run(context.Background(), s, v.ID); err != nil {
		t.Fatal(err)
	}
	if len(seen) < 2 || seen[0] != 1 || seen[1] != 1 {
		t.Fatalf("provider attempts = %v; want durable first attempt on initial read and verification", seen)
	}
	if strings.Contains(string(raw), "dispatchAttempt") {
		t.Fatal("runtime attempt became reviewed payload")
	}
}

func TestGitHubCreateExactPayloadAndReconciliation(t *testing.T) {
	ctx := context.Background()
	scope := Scope{OrgID: "org", SpaceID: "space", SessionID: "room", PrincipalID: "person"}
	conn := GitHubConnection{Scope: scope, Owner: "test", Repository: "repo", Token: "secret-test-token", ReadConsent: true, WriteConsent: true, Capability: Capability{Verified: true, Generation: "1", Destination: "github:test/repo", IssueType: "Task"}}
	p := NewGitHubProvider(func(context.Context, Scope) (GitHubConnection, error) { return conn, nil })
	key := strings.Repeat("a", 64)
	step := Step{Key: key, Kind: "create", Title: "API", Notes: "Agreed scope", Body: "Agreed scope\n\n<!-- parley-publication:" + key + " -->", Binding: conn.Capability, DispatchAttempt: 1}
	var requests []plugin.FetchRequest
	var created bool
	p.fetch = func(_ context.Context, r plugin.FetchRequest) (*plugin.FetchResponse, error) {
		requests = append(requests, r)
		if r.URL != "https://api.github.com/repos/test/repo/issues?state=all&per_page=100&page=1" && r.URL != "https://api.github.com/repos/test/repo/issues" {
			t.Fatalf("unexpected request %s", r.URL)
		}
		if r.Method == "POST" {
			var payload map[string]any
			json.Unmarshal(r.Body, &payload)
			if len(payload) != 3 || payload["title"] != "API" || payload["body"] != step.Body || payload["type"] != "Task" {
				t.Fatalf("payload = %v", payload)
			}
			created = true
			return &plugin.FetchResponse{Status: 201, Body: []byte(`{"number":17}`)}, nil
		}
		body := []byte(`[]`)
		if created {
			body, _ = json.Marshal([]map[string]any{{"id": 99, "number": 17, "title": step.Title, "body": step.Body, "type": map[string]any{"name": "Task"}, "html_url": "https://github.com/test/repo/issues/17"}})
		}
		return &plugin.FetchResponse{Status: 200, Body: body}, nil
	}
	cap, err := p.Capability(ctx, scope)
	if err != nil || !cap.Verified {
		t.Fatalf("capability = %#v, %v", cap, err)
	}
	before, err := p.Inspect(ctx, scope, step)
	if err != nil || !before.Known || before.Matches || !before.MutationAllowed {
		t.Fatalf("first inspect = %#v, %v", before, err)
	}
	result, err := p.Apply(ctx, scope, step)
	if err != nil || result != Unknown {
		t.Fatalf("HTTP success must await readback: %s %v", result, err)
	}
	read, err := p.Inspect(ctx, scope, step)
	if err != nil || !read.Known || !read.Matches || read.RemoteID != "17" {
		t.Fatalf("readback = %#v %v", read, err)
	}
	step.DispatchAttempt = 2
	created = false
	read, err = p.Inspect(ctx, scope, step)
	if err != nil || read.Known || read.MutationAllowed {
		t.Fatalf("restarted missing create identity = %#v %v", read, err)
	}
	requests = nil
	result, err = p.Apply(ctx, scope, step)
	if err != nil || result != Failed || len(requests) != 0 {
		t.Fatalf("duplicate dispatch %s %v %d requests", result, err, len(requests))
	}
	step.PreviousOutcome = Failed
	before, err = p.Inspect(ctx, scope, step)
	if err != nil || !before.Known || !before.MutationAllowed {
		t.Fatalf("definitive failure should permit exact retry: %#v %v", before, err)
	}
	result, err = p.Apply(ctx, scope, step)
	if err != nil || result != Unknown || len(requests) != 2 {
		t.Fatalf("exact failed-step retry: %s %v, calls=%d", result, err, len(requests))
	}

}

func TestGitHubNativeDirectionAndNumericIDs(t *testing.T) {
	ctx := context.Background()
	scope := Scope{OrgID: "org", SpaceID: "space", SessionID: "room", PrincipalID: "person"}
	conn := GitHubConnection{Scope: scope, Owner: "test", Repository: "repo", Token: "secret", ReadConsent: true, WriteConsent: true, Capability: Capability{Verified: true, Generation: "1", Destination: "github:test/repo", IssueType: "ordinary", ParentID: "10"}}
	p := NewGitHubProvider(func(context.Context, Scope) (GitHubConnection, error) { return conn, nil })
	issues := map[string]map[string]any{}
	for _, num := range []string{"10", "11", "12"} {
		n, _ := strconv.Atoi(num)
		issues[num] = map[string]any{"id": n + 1000, "number": n, "html_url": "https://github.com/test/repo/issues/" + num}
	}
	var linked, blocked bool
	p.fetch = func(_ context.Context, r plugin.FetchRequest) (*plugin.FetchResponse, error) {
		path := strings.TrimPrefix(r.URL, "https://api.github.com/repos/test/repo/issues")
		var body any
		if r.Method == "DELETE" {
			if path != "/12/dependencies/blocked_by/1011" {
				t.Fatalf("wrong removal ID %s", path)
			}
			blocked = false
			return &plugin.FetchResponse{Status: 200, Body: []byte(`{}`)}, nil
		}
		if r.Method == "POST" {
			var sent map[string]any
			json.Unmarshal(r.Body, &sent)
			switch path {
			case "/10/sub_issues":
				if sent["sub_issue_id"] != float64(1011) || sent["replace_parent"] != false {
					t.Fatalf("parent payload = %v", sent)
				}
				linked = true
			case "/12/dependencies/blocked_by":
				if sent["issue_id"] != float64(1011) {
					t.Fatalf("blocked_by payload = %v", sent)
				}
				blocked = true
			default:
				t.Fatalf("wrong mutation direction %s", path)
			}
			return &plugin.FetchResponse{Status: 201, Body: []byte(`{}`)}, nil
		}
		switch path {
		case "/10", "/11", "/12":
			body = issues[path[1:]]
		case "/11/parent", "/12/parent":
			body = issues["10"]
		case "/10/sub_issues?per_page=100&page=1":
			body = []any{issues["12"]}
			if linked {
				body = []any{issues["11"], issues["12"]}
			}
		case "/12/dependencies/blocked_by?per_page=100&page=1":
			body = []any{}
			if blocked {
				body = []any{issues["11"]}
			}
		case "/11/dependencies/blocking?per_page=100&page=1":
			body = []any{}
			if blocked {
				body = []any{issues["12"]}
			}
		default:
			t.Fatalf("unexpected readback %s", path)
		}
		raw, _ := json.Marshal(body)
		return &plugin.FetchResponse{Status: 200, Body: raw}, nil
	}
	parent := Step{Kind: "parent", RemoteID: "11", Binding: conn.Capability, DispatchAttempt: 1}
	before, err := p.Inspect(ctx, scope, parent)
	if err != nil || !before.Known || before.Matches || !before.MutationAllowed {
		t.Fatalf("parent preflight %#v %v", before, err)
	}
	if result, err := p.Apply(ctx, scope, parent); err != nil || result != Unknown {
		t.Fatalf("parent write %s %v", result, err)
	}
	after, err := p.Inspect(ctx, scope, parent)
	if err != nil || !after.Matches {
		t.Fatalf("parent readback %#v %v", after, err)
	}
	dep := Step{Kind: "dependency", BlockerRemoteID: "11", DependentRemoteID: "12", Binding: conn.Capability, DispatchAttempt: 1}
	before, err = p.Inspect(ctx, scope, dep)
	if err != nil || !before.Known || before.Matches || !before.MutationAllowed {
		t.Fatalf("dependency preflight %#v %v", before, err)
	}
	if result, err := p.Apply(ctx, scope, dep); err != nil || result != Unknown {
		t.Fatalf("dependency write %s %v", result, err)
	}
	after, err = p.Inspect(ctx, scope, dep)
	if err != nil || !after.Matches {
		t.Fatalf("dependency readback %#v %v", after, err)
	}
	remove := dep
	remove.Kind = "remove-dependency"
	if result, err := p.Apply(ctx, scope, remove); err != nil || result != Unknown {
		t.Fatalf("remove %s %v", result, err)
	}
	after, err = p.Inspect(ctx, scope, remove)
	if err != nil || !after.Matches {
		t.Fatalf("removal readback %#v %v", after, err)
	}
	blocked = false
	dep.DispatchAttempt = 2
	after, err = p.Inspect(ctx, scope, dep)
	if err != nil || after.Known || after.MutationAllowed {
		t.Fatalf("ambiguous add %#v %v", after, err)
	}
	dep.DispatchAttempt = 1
	original := p.fetch
	mutations := 0
	p.fetch = func(ctx context.Context, r plugin.FetchRequest) (*plugin.FetchResponse, error) {
		if r.Method == "POST" {
			mutations++
		}
		response, err := original(ctx, r)
		if r.Method == "GET" {
			conn.WriteConsent = false
		}
		return response, err
	}
	if result, err := p.Apply(ctx, scope, dep); result != Failed || mutations != 0 {
		t.Fatalf("revoked during readback: %s %v, writes=%d", result, err, mutations)
	}

}

func TestGitHubConnectionAndReadbackGuards(t *testing.T) {
	scope := Scope{OrgID: "org", SpaceID: "space", SessionID: "room", PrincipalID: "person"}
	base := GitHubConnection{Scope: scope, Owner: "test", Repository: "repo", Token: "secret", ReadConsent: true, WriteConsent: true, Capability: Capability{Verified: true, Generation: "1", Destination: "github:test/repo", IssueType: "ordinary"}}
	key := strings.Repeat("b", 64)
	step := Step{Key: key, Kind: "create", Title: "API", Body: "\n\n<!-- parley-publication:" + key + " -->", Binding: base.Capability, DispatchAttempt: 1}
	for _, name := range []string{"org", "space", "room", "principal", "read", "write", "destination", "binding", "path", "marker", "later-attempt", "empty-scope"} {
		t.Run(name, func(t *testing.T) {
			conn := base
			requestedScope := scope
			s := step
			switch name {
			case "empty-scope":
				conn.Scope = Scope{}
				requestedScope = Scope{}
			case "org":
				conn.Scope.OrgID = "foreign"
			case "space":
				conn.Scope.SpaceID = "foreign"
			case "room":
				conn.Scope.SessionID = "foreign"
			case "principal":
				conn.Scope.PrincipalID = "foreign"
			case "read":
				conn.ReadConsent = false
			case "write":
				conn.WriteConsent = false
			case "destination":
				conn.Capability.Destination = "github:foreign/repo"
			case "binding":
				s.Binding.Generation = "stale"
			case "path":
				conn.Repository = "../private"
			case "marker":
				s.Body = "unreviewed marker"
			case "later-attempt":
				s.DispatchAttempt = 2
			}
			p := NewGitHubProvider(func(context.Context, Scope) (GitHubConnection, error) { return conn, nil })
			calls := 0
			p.fetch = func(context.Context, plugin.FetchRequest) (*plugin.FetchResponse, error) {
				calls++
				return nil, errors.New("secret must not be exposed")
			}
			result, err := p.Apply(context.Background(), requestedScope, s)
			if result != Failed || calls != 0 {
				t.Fatalf("refused %s: %s, %v, %d calls", name, result, err, calls)
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Fatal("credential leaked")
			}
		})
	}
	for _, name := range []string{"absent-after-restart", "wrong-type", "wrong-body", "duplicate", "foreign-repo", "pull-request", "truncated", "redirect", "denied", "transport-error", "unsupported-estimate"} {
		t.Run(name, func(t *testing.T) {
			p := NewGitHubProvider(func(context.Context, Scope) (GitHubConnection, error) { return base, nil })
			s := step
			s.DispatchAttempt = 2
			i := map[string]any{"id": 88, "number": 17, "title": s.Title, "body": s.Body, "html_url": "https://github.com/test/repo/issues/17"}
			items := []any{i}
			status := 200
			switch name {
			case "absent-after-restart":
				items = nil
			case "wrong-type":
				i["type"] = map[string]string{"name": "Task"}
			case "wrong-body":
				i["body"] = s.Body + " changed"
			case "duplicate":
				items = append(items, i)
			case "foreign-repo":
				i["html_url"] = "https://github.com/foreign/repo/issues/17"
			case "pull-request":
				i["pull_request"] = map[string]any{"url": "private"}
			case "truncated":
				items = make([]any, 100)
				for idx := range items {
					items[idx] = map[string]any{"body": "other"}
				}
			case "redirect":
				status = 302
			case "denied":
				status = 404
			case "unsupported-estimate":
				s.Kind = "estimate"
				s.Value = "0"
			}
			calls := 0
			p.fetch = func(_ context.Context, r plugin.FetchRequest) (*plugin.FetchResponse, error) {
				calls++
				if !r.NoRedirect || !strings.HasPrefix(r.URL, "https://api.github.com/repos/test/repo/issues?") {
					t.Fatalf("unguarded target %s", r.URL)
				}
				if name == "transport-error" {
					return nil, errors.New("secret server response")
				}
				raw, _ := json.Marshal(items)
				return &plugin.FetchResponse{Status: status, Body: raw, Headers: map[string]string{"Location": "http://127.0.0.1/secret"}}, nil
			}
			o, err := p.Inspect(context.Background(), scope, s)
			if o.Known || o.MutationAllowed || o.Matches {
				t.Fatalf("uncertain readback = %#v", o)
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Fatal("provider body leaked")
			}
			if calls > 10 {
				t.Fatalf("pagination calls=%d", calls)
			}
			if name == "unsupported-estimate" && calls != 0 {
				t.Fatal("estimate unexpectedly queried")
			}
		})
	}
}

func TestGitHubEngineInterruptedCreateReconcilesAfterRestart(t *testing.T) {
	e, scope, request, f := fixture(t)
	request.Children = request.Children[:1]
	cap := f.cap
	cap.ParentID = "10"
	cap.IssueType = "ordinary"
	conn := GitHubConnection{Scope: scope, Owner: "test", Repository: "repo", Token: "secret", ReadConsent: true, WriteConsent: true, Capability: cap}
	visible := false
	calls := 0
	var createdBody, createdTitle string
	build := func() *GitHubProvider {
		p := NewGitHubProvider(func(context.Context, Scope) (GitHubConnection, error) { return conn, nil })
		p.fetch = func(_ context.Context, r plugin.FetchRequest) (*plugin.FetchResponse, error) {
			if r.Method == "POST" {
				calls++
				var payload map[string]string
				json.Unmarshal(r.Body, &payload)
				createdBody = payload["body"]
				createdTitle = payload["title"]
				return nil, errors.New("timeout after transmission")
			}
			if strings.Contains(r.URL, "?state=all") {
				raw := []byte(`[]`)
				if visible {
					raw, _ = json.Marshal([]map[string]any{{"id": 99, "number": 17, "title": createdTitle, "body": createdBody, "html_url": "https://github.com/test/repo/issues/17"}})
				}
				return &plugin.FetchResponse{Status: 200, Body: raw}, nil
			}
			return &plugin.FetchResponse{Status: 404, Body: []byte(`{}`)}, nil
		}
		return p
	}
	e.Provider = build()
	v := approve(t, e, scope, request)
	if err := e.Run(context.Background(), scope, v.ID); err != nil {
		t.Fatal(err)
	}
	receipts, err := e.Receipts(context.Background(), scope, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if receipts[0].State != Unknown || calls != 1 {
		t.Fatalf("interrupted create = %#v, %d calls", receipts[0], calls)
	}
	e.Provider = build()
	if err := e.Run(context.Background(), scope, v.ID); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("restarted process recreated unknown issue: %d", calls)
	}
	visible = true
	e.Provider = build()
	if err := e.Run(context.Background(), scope, v.ID); err != nil {
		t.Fatal(err)
	}
	receipts, err = e.Receipts(context.Background(), scope, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if receipts[0].State != Confirmed || receipts[0].RemoteID != "17" || calls != 1 {
		t.Fatalf("reconciled receipt = %#v; creates=%d", receipts[0], calls)
	}
}

func TestGitHubEngineDefinitiveFailureRetriesExactIdentity(t *testing.T) {
	e, scope, request, f := fixture(t)
	request.Children = request.Children[:1]
	cap := f.cap
	cap.ParentID = "10"
	cap.IssueType = "ordinary"
	conn := GitHubConnection{Scope: scope, Owner: "test", Repository: "repo", Token: "secret", ReadConsent: true, WriteConsent: true, Capability: cap}
	p := NewGitHubProvider(func(context.Context, Scope) (GitHubConnection, error) { return conn, nil })
	attempts := 0
	var body, title string
	var keys []string
	p.fetch = func(_ context.Context, r plugin.FetchRequest) (*plugin.FetchResponse, error) {
		if r.Method == "POST" {
			attempts++
			var payload map[string]string
			json.Unmarshal(r.Body, &payload)
			body = payload["body"]
			title = payload["title"]
			keys = append(keys, body)
			status := 201
			if attempts == 1 {
				status = 403
			}
			return &plugin.FetchResponse{Status: status, Body: []byte(`{}`)}, nil
		}
		if strings.Contains(r.URL, "?state=all") {
			raw := []byte(`[]`)
			if attempts > 1 {
				raw, _ = json.Marshal([]map[string]any{{"id": 99, "number": 17, "title": title, "body": body, "html_url": "https://github.com/test/repo/issues/17"}})
			}
			return &plugin.FetchResponse{Status: 200, Body: raw}, nil
		}
		return &plugin.FetchResponse{Status: 404, Body: []byte(`{}`)}, nil
	}
	e.Provider = p
	v := approve(t, e, scope, request)
	if err := e.Run(context.Background(), scope, v.ID); err != nil {
		t.Fatal(err)
	}
	receipts, err := e.Receipts(context.Background(), scope, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if receipts[0].State != Failed || attempts != 1 {
		t.Fatalf("first refusal = %#v; writes=%d", receipts[0], attempts)
	}
	if err := e.Run(context.Background(), scope, v.ID); err != nil {
		t.Fatal(err)
	}
	receipts, err = e.Receipts(context.Background(), scope, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if receipts[0].State != Confirmed || attempts != 2 || keys[0] != keys[1] {
		t.Fatalf("exact retry = %#v; writes=%d; same identity=%v", receipts[0], attempts, len(keys) == 2 && keys[0] == keys[1])
	}
}
