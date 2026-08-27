package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultOrgSlug names the org every space lands in until an instance is
// actually divided into several. The migration creates it, so it is always
// there to resolve.
const DefaultOrgSlug = "default"

// Org roles. An admin manages the org's membership and its spaces; a member
// belongs to it and nothing more. The same two values are the org_members.role
// CHECK constraint.
const (
	OrgRoleAdmin  = "admin"
	OrgRoleMember = "member"
)

var ErrNoOrg = errors.New("no such org")

// Org is a tenant: a set of people, and the spaces those people own. Org
// membership is deliberately not space membership — it decides what someone
// can find, not what they can join.
type Org struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type Orgs struct {
	Pool *pgxpool.Pool
}

func (o *Orgs) BySlug(ctx context.Context, slug string) (Org, error) {
	var org Org
	err := o.Pool.QueryRow(ctx, "select id, slug, name from orgs where slug = $1", slug).
		Scan(&org.ID, &org.Slug, &org.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return Org{}, ErrNoOrg
	}
	if err != nil {
		return Org{}, fmt.Errorf("reading org: %w", err)
	}
	return org, nil
}

// Default resolves the org every caller belongs to until an instance grows a
// second one.
func (o *Orgs) Default(ctx context.Context) (Org, error) {
	return o.BySlug(ctx, DefaultOrgSlug)
}

// AddMember enrols someone, or restores a membership that was revoked. The
// role is re-applied on conflict so a re-add is not silently a no-op that
// leaves an old role in place.
func (o *Orgs) AddMember(ctx context.Context, orgID, userID, role string) error {
	if role != OrgRoleAdmin && role != OrgRoleMember {
		return ErrBadRole
	}
	_, err := o.Pool.Exec(ctx, `
		insert into org_members (org_id, user_id, role) values ($1, $2, $3)
		on conflict (org_id, user_id) do update set role = excluded.role, revoked_at = null`,
		orgID, userID, role)
	if err != nil {
		return fmt.Errorf("adding an org member: %w", err)
	}
	return nil
}

// IsMember answers whether someone currently belongs to an org. A revoked row
// is not a membership: revocation is a stamp rather than a delete, so custody
// history survives someone being removed.
func (o *Orgs) IsMember(ctx context.Context, orgID, userID string) (bool, error) {
	var ok bool
	err := o.Pool.QueryRow(ctx,
		"select exists (select 1 from org_members where org_id = $1 and user_id = $2 and revoked_at is null)",
		orgID, userID).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("checking org membership: %w", err)
	}
	return ok, nil
}
