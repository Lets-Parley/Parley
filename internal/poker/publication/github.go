package publication

import (
	"context"
	"encoding/json"

	"regexp"
	"strconv"
	"strings"

	"github.com/lets-parley/parley/internal/plugin"
)

// GitHubConnection must be resolved by the trusted host for the entire scope.
// Credentials and verification cannot come from a publication request.
type GitHubConnection struct {
	Scope                     Scope
	Capability                Capability
	Owner, Repository, Token  string
	ReadConsent, WriteConsent bool
}

type GitHubProvider struct {
	resolve func(context.Context, Scope) (GitHubConnection, error)
	fetch   func(context.Context, plugin.FetchRequest) (*plugin.FetchResponse, error)
}

func NewGitHubProvider(resolve func(context.Context, Scope) (GitHubConnection, error)) *GitHubProvider {
	f := &plugin.Fetcher{}
	return &GitHubProvider{resolve: resolve, fetch: func(ctx context.Context, r plugin.FetchRequest) (*plugin.FetchResponse, error) {
		return f.Do(ctx, []string{"api.github.com"}, r, false)
	}}
}

var githubName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)
var githubKey = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (p *GitHubProvider) connection(ctx context.Context, scope Scope) (GitHubConnection, error) {
	if p.resolve == nil {
		return GitHubConnection{}, ErrPaused
	}
	c, err := p.resolve(ctx, scope)
	if err != nil || (scope.OrgID == "" || scope.SpaceID == "" || scope.SessionID == "" || scope.PrincipalID == "" || c.Scope != scope) || !c.ReadConsent || !c.Capability.Verified || c.Capability.Generation == "" || c.Capability.IssueType == "" || !githubName.MatchString(c.Owner) || !githubName.MatchString(c.Repository) || c.Repository == ".." || c.Capability.Destination != "github:"+c.Owner+"/"+c.Repository || c.Token == "" || strings.ContainsAny(c.Token, "\r\n") {
		return GitHubConnection{}, ErrPaused
	}
	return c, nil
}
func (p *GitHubProvider) Capability(ctx context.Context, scope Scope) (Capability, error) {
	c, err := p.connection(ctx, scope)
	if err == nil && c.Capability.ProjectID != "" {
		_, err = p.project(ctx, c)
	}
	return c.Capability, err
}
func (p *GitHubProvider) bound(ctx context.Context, scope Scope, step Step) (GitHubConnection, error) {
	c, err := p.connection(ctx, scope)
	if err != nil || digest(c.Capability) != digest(step.Binding) {
		return GitHubConnection{}, ErrPaused
	}
	return c, nil
}
func (p *GitHubProvider) request(ctx context.Context, c GitHubConnection, method, path string, body any) (*plugin.FetchResponse, error) {
	return p.apiRequest(ctx, c, method, "https://api.github.com/repos/"+c.Owner+"/"+c.Repository+"/issues"+path, body)
}
func (p *GitHubProvider) apiRequest(ctx context.Context, c GitHubConnection, method, url string, body any) (*plugin.FetchResponse, error) {
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil || len(raw) > 65536 {
			return nil, ErrPaused
		}
	}
	r, err := p.fetch(ctx, plugin.FetchRequest{Method: method, URL: url, Headers: map[string]string{"Authorization": "Bearer " + c.Token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json"}, Body: raw, NoRedirect: true})
	if err != nil || r == nil || len(r.Body) > 1<<20 {
		return nil, ErrPaused
	}
	return r, nil
}

type githubIssue struct {
	ID          int64           `json:"id"`
	NodeID      string          `json:"node_id"`
	Number      int64           `json:"number"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	HTMLURL     string          `json:"html_url"`
	PullRequest json.RawMessage `json:"pull_request"`
	Type        *struct {
		Name string `json:"name"`
	} `json:"type"`
}

func (c GitHubConnection) validIssue(i githubIssue) bool {
	return i.ID > 0 && i.Number > 0 && len(i.PullRequest) == 0 && i.HTMLURL == "https://github.com/"+c.Owner+"/"+c.Repository+"/issues/"+strconv.FormatInt(i.Number, 10)
}
func (p *GitHubProvider) list(ctx context.Context, c GitHubConnection, path string) ([]githubIssue, bool) {
	var out []githubIssue
	for page := 1; page <= 10; page++ {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		r, err := p.request(ctx, c, "GET", path+sep+"per_page=100&page="+strconv.Itoa(page), nil)
		if err != nil || r.Status != 200 {
			return nil, false
		}
		var items []githubIssue
		if json.Unmarshal(r.Body, &items) != nil || len(items) > 100 {
			return nil, false
		}
		out = append(out, items...)
		if len(items) < 100 && !strings.Contains(r.Headers["link"], `rel="next"`) {
			return out, true
		}
	}
	return nil, false
}
func githubMayTransmit(step Step) bool {
	return step.DispatchAttempt > 0 && (step.DispatchAttempt == 1 || step.PreviousOutcome == Failed)
}
func validGitHubCreate(step Step) bool {
	return githubKey.MatchString(step.Key) && len(step.Title) > 0 && len(step.Title) <= 256 && len(step.Body) <= 60000 && !strings.Contains(step.Notes, "parley-publication:") && step.Body == step.Notes+"\n\n<!-- parley-publication:"+step.Key+" -->"
}
func (p *GitHubProvider) CanSend(step Step) bool {
	return step.Kind != "create" || validGitHubCreate(step)
}
func (p *GitHubProvider) Inspect(ctx context.Context, scope Scope, step Step) (Observation, error) {
	c, err := p.bound(ctx, scope, step)
	if err != nil {
		return Observation{}, err
	}
	if step.Kind == "project" {
		return p.inspectProjectMembership(ctx, c, step), nil
	}
	if step.Kind == "estimate" {
		return p.inspectEstimate(ctx, c, step), nil
	}
	if step.Kind != "create" {
		return p.inspectNative(ctx, c, step), nil
	}
	if !validGitHubCreate(step) {
		return Observation{}, ErrPaused
	}
	issues, complete := p.list(ctx, c, "?state=all")
	if !complete {
		return Observation{}, nil
	}
	marker := "<!-- parley-publication:" + step.Key + " -->"
	var matches []githubIssue
	for _, i := range issues {
		if strings.Contains(i.Body, marker) {
			matches = append(matches, i)
		}
	}
	if len(matches) == 1 {
		i := matches[0]
		typeMatches := step.Binding.IssueType == "ordinary" && i.Type == nil || i.Type != nil && i.Type.Name == step.Binding.IssueType
		if c.validIssue(i) && i.Title == step.Title && i.Body == step.Body && typeMatches {
			return Observation{Known: true, Matches: true, RemoteID: strconv.FormatInt(i.Number, 10)}, nil
		}
		return Observation{}, nil
	}
	if len(matches) > 1 || !githubMayTransmit(step) {
		return Observation{}, nil
	}
	// First claim or a definitive refusal permits transmission; unknown absence never does.
	return Observation{Known: true, MutationAllowed: c.WriteConsent}, nil
}
func (p *GitHubProvider) Apply(ctx context.Context, scope Scope, step Step) (Outcome, error) {
	c, err := p.bound(ctx, scope, step)
	if err != nil {
		return Failed, err
	}
	if !c.WriteConsent || !githubMayTransmit(step) {
		return Failed, nil
	}
	if step.Kind == "project" {
		return p.applyProjectMembership(ctx, scope, c, step)
	}
	if step.Kind == "estimate" {
		return p.applyEstimate(ctx, scope, c, step)
	}
	if step.Kind != "create" {
		observation := p.inspectNative(ctx, c, step)
		if !observation.Known {
			return Failed, nil
		}
		if observation.Matches {
			return Unknown, nil
		}
		if !observation.MutationAllowed {
			return Failed, nil
		}
	}
	var path, method string
	var payload any
	switch step.Kind {
	case "create":
		if !validGitHubCreate(step) {
			return Failed, nil
		}
		value := map[string]string{"title": step.Title, "body": step.Body}
		if step.Binding.IssueType != "ordinary" {
			value["type"] = step.Binding.IssueType
		}
		payload = value
		method = "POST"
	case "parent":
		child, ok := p.issue(ctx, c, step.RemoteID)
		if !ok {
			return Failed, nil
		}
		path = "/" + c.Capability.ParentID + "/sub_issues"
		method = "POST"
		payload = map[string]any{"sub_issue_id": child.ID, "replace_parent": false}
	case "dependency", "remove-dependency":
		blocker, ok := p.issue(ctx, c, step.BlockerRemoteID)
		if !ok {
			return Failed, nil
		}
		path = "/" + step.DependentRemoteID + "/dependencies/blocked_by"
		method = "POST"
		payload = map[string]any{"issue_id": blocker.ID}
		if step.Kind == "remove-dependency" {
			method = "DELETE"
			path += "/" + strconv.FormatInt(blocker.ID, 10)
			payload = nil
		}
	default:
		return Failed, nil
	}
	c, err = p.bound(ctx, scope, step)
	if err != nil || !c.WriteConsent {
		return Failed, ErrPaused
	}
	r, err := p.request(ctx, c, method, path, payload)
	if err != nil {
		return Unknown, err
	}
	if r.Status == 401 || r.Status == 403 || r.Status == 404 || r.Status == 422 {
		return Failed, nil
	}
	return Unknown, nil
}

func githubNumber(number string) bool {
	n, err := strconv.ParseInt(number, 10, 64)
	return err == nil && n > 0 && strconv.FormatInt(n, 10) == number
}
func (p *GitHubProvider) issue(ctx context.Context, c GitHubConnection, number string) (githubIssue, bool) {
	if !githubNumber(number) {
		return githubIssue{}, false
	}
	r, err := p.request(ctx, c, "GET", "/"+number, nil)
	var i githubIssue
	if err != nil || r.Status != 200 || json.Unmarshal(r.Body, &i) != nil || !c.validIssue(i) || strconv.FormatInt(i.Number, 10) != number {
		return githubIssue{}, false
	}
	return i, true
}
func (p *GitHubProvider) parentMatches(ctx context.Context, c GitHubConnection, child, parent githubIssue) bool {
	r, err := p.request(ctx, c, "GET", "/"+strconv.FormatInt(child.Number, 10)+"/parent", nil)
	var found githubIssue
	return err == nil && r.Status == 200 && json.Unmarshal(r.Body, &found) == nil && c.validIssue(found) && found.ID == parent.ID && found.Number == parent.Number
}
func githubListContains(c GitHubConnection, list []githubIssue, want githubIssue) (bool, bool) {
	found := false
	for _, i := range list {
		if !c.validIssue(i) {
			return false, false
		}
		if i.ID == want.ID || i.Number == want.Number {
			if i.ID != want.ID || i.Number != want.Number || found {
				return false, false
			}
			found = true
		}
	}
	return found, true
}
func (p *GitHubProvider) inspectNative(ctx context.Context, c GitHubConnection, step Step) Observation {
	if step.Kind != "parent" && step.Kind != "dependency" && step.Kind != "remove-dependency" {
		return Observation{}
	}
	parent, ok := p.issue(ctx, c, c.Capability.ParentID)
	if !ok {
		return Observation{}
	}
	children, complete := p.list(ctx, c, "/"+c.Capability.ParentID+"/sub_issues")
	if !complete {
		return Observation{}
	}
	if step.Kind == "parent" {
		child, ok := p.issue(ctx, c, step.RemoteID)
		if !ok || child.ID == parent.ID {
			return Observation{}
		}
		found, valid := githubListContains(c, children, child)
		if !valid {
			return Observation{}
		}
		if found {
			if !p.parentMatches(ctx, c, child, parent) {
				return Observation{}
			}
			return Observation{Known: true, Matches: true}
		}
		if !githubMayTransmit(step) {
			return Observation{Known: step.DispatchAttempt == 0}
		}
		return Observation{Known: true, MutationAllowed: c.WriteConsent}
	}
	blocker, ok := p.issue(ctx, c, step.BlockerRemoteID)
	if !ok {
		return Observation{}
	}
	dependent, ok := p.issue(ctx, c, step.DependentRemoteID)
	if !ok || blocker.ID == dependent.ID {
		return Observation{}
	}
	for _, i := range []githubIssue{blocker, dependent} {
		found, valid := githubListContains(c, children, i)
		if !found || !valid || !p.parentMatches(ctx, c, i, parent) {
			return Observation{}
		}
	}
	by, complete := p.list(ctx, c, "/"+step.DependentRemoteID+"/dependencies/blocked_by")
	if !complete {
		return Observation{}
	}
	blocking, complete := p.list(ctx, c, "/"+step.BlockerRemoteID+"/dependencies/blocking")
	if !complete {
		return Observation{}
	}
	forward, valid := githubListContains(c, by, blocker)
	if !valid {
		return Observation{}
	}
	reverse, valid := githubListContains(c, blocking, dependent)
	if !valid || forward != reverse {
		return Observation{}
	}
	matches := forward
	if step.Kind == "remove-dependency" {
		matches = !forward
	}
	if matches {
		return Observation{Known: true, Matches: true}
	}
	if !githubMayTransmit(step) {
		return Observation{Known: step.DispatchAttempt == 0}
	}
	return Observation{Known: true, MutationAllowed: c.WriteConsent}
}
