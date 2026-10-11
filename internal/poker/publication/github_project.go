package publication

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
)

const githubProjectQuery = `query($project:ID!){node(id:$project){... on ProjectV2{id closed viewerCanUpdate owner{... on User{login} ... on Organization{login}} fields(first:100){pageInfo{hasNextPage} nodes{... on ProjectV2Field{id dataType}}} items(first:100){pageInfo{hasNextPage} nodes{id isArchived content{... on Issue{id number repository{nameWithOwner}}} fieldValues(first:100){pageInfo{hasNextPage} nodes{... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2Field{id}}}}}}}}}}`

type githubPage struct{ HasNextPage *bool }
type githubProjectItem struct {
	ID         string
	IsArchived bool
	Content    struct {
		ID         string
		Number     int64
		Repository struct{ NameWithOwner string }
	}
	FieldValues struct {
		PageInfo githubPage
		Nodes    []struct {
			Number *float64
			Field  struct{ ID string }
		}
	}
}
type githubProject struct {
	ID                      string
	Closed, ViewerCanUpdate bool
	Owner                   struct{ Login string }
	Fields                  struct {
		PageInfo githubPage
		Nodes    []struct{ ID, DataType string }
	}
	Items struct {
		PageInfo githubPage
		Nodes    []githubProjectItem
	}
}

func (p githubPage) complete() bool { return p.HasNextPage != nil && !*p.HasNextPage }

func (p *GitHubProvider) graphql(ctx context.Context, c GitHubConnection, query string, variables map[string]any, out any) error {
	r, err := p.apiRequest(ctx, c, "POST", "https://api.github.com/graphql", map[string]any{"query": query, "variables": variables})
	if err != nil || r.Status != 200 {
		return ErrPaused
	}
	var envelope struct {
		Data   json.RawMessage
		Errors []json.RawMessage
	}
	if json.Unmarshal(r.Body, &envelope) != nil || len(envelope.Errors) > 0 || len(envelope.Data) == 0 || string(envelope.Data) == "null" || json.Unmarshal(envelope.Data, out) != nil {
		return ErrPaused
	}
	return nil
}
func (p *GitHubProvider) project(ctx context.Context, c GitHubConnection) (githubProject, error) {
	var data struct{ Node githubProject }
	if c.Capability.ProjectID == "" || c.Capability.FieldID == "" || !githubNumber(c.Capability.ParentID) {
		return data.Node, ErrPaused
	}
	if p.graphql(ctx, c, githubProjectQuery, map[string]any{"project": c.Capability.ProjectID}, &data) != nil {
		return data.Node, ErrPaused
	}
	v := data.Node
	if v.ID != c.Capability.ProjectID || v.Closed || !v.ViewerCanUpdate || v.Owner.Login != c.Owner || !v.Fields.PageInfo.complete() || !v.Items.PageInfo.complete() || len(v.Fields.Nodes) > 100 || len(v.Items.Nodes) > 100 || v.Items.Nodes == nil {
		return v, ErrPaused
	}
	found := 0
	for _, f := range v.Fields.Nodes {
		if f.ID == c.Capability.FieldID {
			if f.DataType != "NUMBER" {
				return v, ErrPaused
			}
			found++
		}
	}
	if found != 1 {
		return v, ErrPaused
	}
	seen := map[int64]bool{}
	parent, _ := strconv.ParseInt(c.Capability.ParentID, 10, 64)
	for _, item := range v.Items.Nodes {
		if item.ID == "" || item.Content.ID == "" || item.Content.Number <= 0 || item.Content.Repository.NameWithOwner != c.Owner+"/"+c.Repository || seen[item.Content.Number] || item.Content.Number == parent || !item.FieldValues.PageInfo.complete() || len(item.FieldValues.Nodes) > 100 {
			return v, ErrPaused
		}
		seen[item.Content.Number] = true
	}
	return v, nil
}
func githubEstimateValue(c GitHubConnection, step Step) (float64, bool) {
	if step.Value == "" {
		return 0, true
	}
	n, err := strconv.ParseFloat(step.Value, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, false
	}
	for _, mapped := range c.Capability.Mapping {
		if mapped == step.Value {
			return n, true
		}
	}
	return 0, false
}
func (p *GitHubProvider) estimateSnapshot(ctx context.Context, c GitHubConnection, step Step) (githubProjectItem, bool, bool) {
	var empty githubProjectItem
	if _, ok := githubEstimateValue(c, step); !ok {
		return empty, false, false
	}
	parent, ok := p.issue(ctx, c, c.Capability.ParentID)
	if !ok {
		return empty, false, false
	}
	child, ok := p.issue(ctx, c, step.RemoteID)
	if !ok || child.NodeID == "" || child.ID == parent.ID || !p.parentMatches(ctx, c, child, parent) {
		return empty, false, false
	}
	project, err := p.project(ctx, c)
	if err != nil {
		return empty, false, false
	}
	for _, item := range project.Items.Nodes {
		if item.Content.Number == child.Number {
			if item.Content.ID != child.NodeID || item.IsArchived {
				return empty, false, false
			}
			return item, true, true
		}
	}
	empty.Content.ID = child.NodeID
	return empty, false, true
}
func (p *GitHubProvider) inspectEstimate(ctx context.Context, c GitHubConnection, step Step) Observation {
	item, member, ok := p.estimateSnapshot(ctx, c, step)
	if !ok {
		return Observation{}
	}
	var value *float64
	count := 0
	for _, field := range item.FieldValues.Nodes {
		if field.Field.ID == c.Capability.FieldID {
			value = field.Number
			count++
		}
	}
	if count > 1 || count == 1 && value == nil {
		return Observation{}
	}
	desired, _ := githubEstimateValue(c, step)
	if member && (step.Value == "" && value == nil || step.Value != "" && value != nil && *value == desired) {
		return Observation{Known: true, Matches: true}
	}
	// Read-only reconciliation can confirm an unset baseline without authorizing a write.
	if member && value == nil && step.DispatchAttempt == 0 {
		return Observation{Known: true}
	}
	// Only an unset baseline permits a first transmission. Provider defaults are never overwritten.
	if value != nil || !githubMayTransmit(step) {
		return Observation{}
	}
	return Observation{Known: true, MutationAllowed: c.WriteConsent && step.Value != ""}
}
func (p *GitHubProvider) applyEstimate(ctx context.Context, scope Scope, c GitHubConnection, step Step) (Outcome, error) {
	observation := p.inspectEstimate(ctx, c, step)
	if observation.Matches {
		return Unknown, nil
	}
	if !observation.Known || !observation.MutationAllowed {
		return Failed, nil
	}
	item, member, ok := p.estimateSnapshot(ctx, c, step)
	if !ok || !member {
		return Failed, nil
	}
	// Re-read the baseline after membership/default workflows and reauthorize the exact binding.
	observation = p.inspectEstimate(ctx, c, step)
	if observation.Matches {
		return Unknown, nil
	}
	if !observation.Known || !observation.MutationAllowed {
		return Unknown, nil
	}
	c, err := p.bound(ctx, scope, step)
	if err != nil || !c.WriteConsent {
		return Failed, ErrPaused
	}
	value, _ := githubEstimateValue(c, step)
	var data struct {
		UpdateProjectV2ItemFieldValue struct{ ProjectV2Item struct{ ID string } }
	}
	err = p.graphql(ctx, c, `mutation($project:ID!,$item:ID!,$field:ID!,$value:Float!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{number:$value}}){projectV2Item{id}}}`, map[string]any{"project": c.Capability.ProjectID, "item": item.ID, "field": c.Capability.FieldID, "value": value}, &data)
	if err != nil || data.UpdateProjectV2ItemFieldValue.ProjectV2Item.ID != item.ID {
		return Unknown, nil
	}
	return Unknown, nil
}

func (p *GitHubProvider) inspectProjectMembership(ctx context.Context, c GitHubConnection, step Step) Observation {
	_, member, ok := p.estimateSnapshot(ctx, c, step)
	if !ok {
		return Observation{}
	}
	if member {
		return Observation{Known: true, Matches: true}
	}
	if !githubMayTransmit(step) {
		return Observation{Known: step.DispatchAttempt == 0}
	}
	return Observation{Known: true, MutationAllowed: c.WriteConsent}
}
func (p *GitHubProvider) applyProjectMembership(ctx context.Context, scope Scope, c GitHubConnection, step Step) (Outcome, error) {
	observation := p.inspectProjectMembership(ctx, c, step)
	if observation.Matches {
		return Unknown, nil
	}
	if !observation.Known || !observation.MutationAllowed {
		return Failed, nil
	}
	item, member, ok := p.estimateSnapshot(ctx, c, step)
	if !ok || member {
		return Unknown, nil
	}
	c, err := p.bound(ctx, scope, step)
	if err != nil || !c.WriteConsent {
		return Failed, ErrPaused
	}
	var data struct {
		AddProjectV2ItemById struct{ Item struct{ ID string } }
	}
	err = p.graphql(ctx, c, `mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`, map[string]any{"project": c.Capability.ProjectID, "content": item.Content.ID}, &data)
	if err != nil || data.AddProjectV2ItemById.Item.ID == "" {
		return Unknown, nil
	}
	return Unknown, nil
}
