package publication

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/plugin"
)

type ConnectionConfig struct {
	Owner        string `json:"owner"`
	Repository   string `json:"repository"`
	ParentID     string `json:"parentId"`
	ProjectID    string `json:"projectId"`
	FieldID      string `json:"fieldId"`
	ReadConsent  bool   `json:"readConsent"`
	WriteConsent bool   `json:"writeConsent"`
}

type Connections struct {
	Pool    *pgxpool.Pool
	Secrets *plugin.Store
}

func connectionScope(s Scope) string {
	return strings.Join([]string{s.OrgID, s.SpaceID, s.SessionID, s.PrincipalID}, "|")
}
func (c *Connections) save(ctx context.Context, s Scope, config ConnectionConfig, token string) error {
	if c.Secrets == nil || c.Secrets.Cipher == nil {
		return ErrPaused
	}
	tx, err := c.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "lock table secret_binding in share mode"); err != nil {
		return err
	}
	if err = (&Engine{}).authorize(ctx, tx, s, true); err != nil {
		return err
	}
	var id string
	if err = tx.QueryRow(ctx, `select coalesce((select id from poker_publication_connections where org_id=$1 and space_id=$2 and session_id=$3 and principal_id=$4),gen_random_uuid())::text`, s.OrgID, s.SpaceID, s.SessionID, s.PrincipalID).Scan(&id); err != nil {
		return err
	}
	nonce, sealed, key, err := c.Secrets.Cipher.Seal(plugin.PublicationSecretAAD(id, connectionScope(s)), token)
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(config)
	_, err = tx.Exec(ctx, `insert into poker_publication_connections(id,org_id,space_id,session_id,principal_id,config,nonce,ciphertext,key_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(org_id,space_id,session_id,principal_id) do update set generation=gen_random_uuid(),config=excluded.config,nonce=excluded.nonce,ciphertext=excluded.ciphertext,key_id=excluded.key_id`, id, s.OrgID, s.SpaceID, s.SessionID, s.PrincipalID, raw, nonce, sealed, key)
	if err != nil {
		return fmt.Errorf("storing publication connection: %w", err)
	}
	return tx.Commit(ctx)
}
func (c *Connections) Resolve(ctx context.Context, s Scope) (GitHubConnection, error) {
	result := GitHubConnection{Scope: s}
	if c.Secrets == nil || c.Secrets.Cipher == nil {
		return result, ErrPaused
	}
	var id, generation, key string
	var raw, nonce, sealed []byte
	// Recheck the exact local principal and scope on every provider call.
	err := c.Pool.QueryRow(ctx, `select c.id::text,c.generation::text,c.config,c.nonce,c.ciphertext,c.key_id from poker_publication_connections c
 join sessions s on s.id=c.session_id and s.space_id=c.space_id
 join spaces sp on sp.id=c.space_id and sp.org_id=c.org_id
 join members m on m.space_id=c.space_id and m.user_id=c.principal_id
 join org_members om on om.org_id=c.org_id and om.user_id=c.principal_id
 join users u on u.id=c.principal_id
 where c.org_id=$1 and c.space_id=$2 and c.session_id=$3 and c.principal_id=$4 and s.kind='poker' and s.facilitator_id=$4 and om.revoked_at is null and u.link_id is null`, s.OrgID, s.SpaceID, s.SessionID, s.PrincipalID).Scan(&id, &generation, &raw, &nonce, &sealed, &key)
	if err != nil {
		return result, ErrPaused
	}
	var config ConnectionConfig
	if json.Unmarshal(raw, &config) != nil || !config.ReadConsent {
		return result, ErrPaused
	}
	token, err := c.Secrets.Cipher.OpenBound(key, plugin.PublicationSecretAAD(id, connectionScope(s)), nonce, sealed)
	if err != nil {
		return result, ErrPaused
	}
	result.Owner = config.Owner
	result.Repository = config.Repository
	result.Token = token
	result.ReadConsent = config.ReadConsent
	result.WriteConsent = config.WriteConsent
	result.Capability = Capability{Verified: true, Generation: generation, Destination: "github:" + config.Owner + "/" + config.Repository, IssueType: "ordinary", ParentID: config.ParentID, ParentDisposition: "excluded-from-counting", ProjectID: config.ProjectID, FieldID: config.FieldID, Mapping: map[string]string{}}
	for _, v := range []string{"1", "2", "3", "5", "8", "13", "21", "34"} {
		result.Capability.Mapping[v] = v
	}
	return result, nil
}
func (c *Connections) Revoke(ctx context.Context, s Scope) error {
	tx, err := c.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = (&Engine{}).authorize(ctx, tx, s, false); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `delete from poker_publication_connections where org_id=$1 and space_id=$2 and session_id=$3 and principal_id=$4`, s.OrgID, s.SpaceID, s.SessionID, s.PrincipalID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Connect reads the chosen configuration before retaining the scoped credential.
// This consent authorizes capability reads, not importing remote meeting text.
func (c *Connections) Connect(ctx context.Context, s Scope, config ConnectionConfig, token string) error {
	if !config.ReadConsent || !githubName.MatchString(config.Owner) || !githubName.MatchString(config.Repository) || config.Repository == ".." || !githubNumber(config.ParentID) || config.ProjectID == "" || len(config.ProjectID) > 256 || config.FieldID == "" || len(config.FieldID) > 256 || token == "" || len(token) > 4096 || strings.ContainsAny(token, "\r\n") {
		return ErrPaused
	}
	tx, err := c.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = (&Engine{}).authorize(ctx, tx, s, true); err != nil {
		return err
	}
	tx.Rollback(ctx)
	conn := GitHubConnection{Scope: s, Owner: config.Owner, Repository: config.Repository, Token: token, ReadConsent: true, WriteConsent: config.WriteConsent, Capability: Capability{Verified: true, Generation: "configuration-read", Destination: "github:" + config.Owner + "/" + config.Repository, IssueType: "ordinary", ParentID: config.ParentID, ProjectID: config.ProjectID, FieldID: config.FieldID}}
	p := NewGitHubProvider(func(context.Context, Scope) (GitHubConnection, error) { return conn, nil })
	if err = p.validateConfiguration(ctx, conn); err != nil {
		return ErrPaused
	}
	return c.save(ctx, s, config, token)
}

func (p *GitHubProvider) validateConfiguration(ctx context.Context, c GitHubConnection) error {
	r, err := p.apiRequest(ctx, c, "GET", "https://api.github.com/repos/"+c.Owner+"/"+c.Repository, nil)
	if err != nil || r.Status != 200 {
		return ErrPaused
	}
	var repo struct {
		FullName    string `json:"full_name"`
		HasIssues   bool   `json:"has_issues"`
		Archived    bool
		Permissions struct{ Pull, Push bool }
	}
	if json.Unmarshal(r.Body, &repo) != nil || repo.FullName != c.Owner+"/"+c.Repository || !repo.HasIssues || repo.Archived || !repo.Permissions.Pull || (c.WriteConsent && !repo.Permissions.Push) {
		return ErrPaused
	}
	parent, ok := p.issue(ctx, c, c.Capability.ParentID)
	if !ok || parent.Type != nil || parent.NodeID == "" {
		return ErrPaused
	}
	_, err = p.project(ctx, c)
	return err
}

type scopedGitHubProvider struct{ *GitHubProvider }

func (p *scopedGitHubProvider) Capability(ctx context.Context, s Scope) (Capability, error) {
	c, err := p.connection(ctx, s)
	if err != nil {
		return Capability{}, err
	}
	if err = p.validateConfiguration(ctx, c); err != nil {
		return Capability{}, err
	}
	return c.Capability, nil
}
func (c *Connections) Provider() Provider { return &scopedGitHubProvider{NewGitHubProvider(c.Resolve)} }
