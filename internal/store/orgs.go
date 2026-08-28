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

// ErrNotOrgMember is what a lookup reports for someone outside an org. It is
// distinct from ErrNoOrg so a caller cannot mistake "there is no such org" for
// "you are not in it" — the HTTP surface answers both with the same 404, but
// the store keeps them apart.
var ErrNotOrgMember = errors.New("not a member of this org")

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

// RoleOf reports the caller's standing in an org, or ErrNotOrgMember. A
// revoked row is not a membership, the same reading IsMember takes.
func (o *Orgs) RoleOf(ctx context.Context, orgID, userID string) (string, error) {
	var role string
	err := o.Pool.QueryRow(ctx,
		"select role from org_members where org_id = $1 and user_id = $2 and revoked_at is null",
		orgID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotOrgMember
	}
	if err != nil {
		return "", fmt.Errorf("reading org role: %w", err)
	}
	return role, nil
}

// OrgMembership is one org the caller belongs to, as the org switcher lists
// them. The role rides along so a client can offer the admin surface without a
// second request per org.
type OrgMembership struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// ForUser lists the orgs someone currently belongs to, by name. An empty list
// is a real answer: a signed-in account whose claims matched no org belongs
// nowhere, and the client shows it the dead-end rather than an empty switcher.
func (o *Orgs) ForUser(ctx context.Context, userID string) ([]OrgMembership, error) {
	rows, err := o.Pool.Query(ctx, `
		select o.slug, o.name, m.role
		from org_members m join orgs o on o.id = m.org_id
		where m.user_id = $1 and m.revoked_at is null
		order by o.name`, userID)
	if err != nil {
		return nil, fmt.Errorf("listing orgs: %w", err)
	}
	defer rows.Close()
	orgs := []OrgMembership{}
	for rows.Next() {
		var m OrgMembership
		if err := rows.Scan(&m.Slug, &m.Name, &m.Role); err != nil {
			return nil, fmt.Errorf("listing orgs: %w", err)
		}
		orgs = append(orgs, m)
	}
	return orgs, rows.Err()
}

// ByClaimValues resolves the orgs an identity provider's claim values map to.
// Matching is exact and case-sensitive, and a value no org registered maps to
// nothing: a claim never creates an org.
func (o *Orgs) ByClaimValues(ctx context.Context, values []string) ([]Org, error) {
	if len(values) == 0 {
		return nil, nil
	}
	rows, err := o.Pool.Query(ctx,
		"select id, slug, name from orgs where claim_value = any($1)", values)
	if err != nil {
		return nil, fmt.Errorf("reading orgs by claim: %w", err)
	}
	defer rows.Close()
	var orgs []Org
	for rows.Next() {
		var org Org
		if err := rows.Scan(&org.ID, &org.Slug, &org.Name); err != nil {
			return nil, fmt.Errorf("reading orgs by claim: %w", err)
		}
		orgs = append(orgs, org)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading orgs by claim: %w", err)
	}
	return orgs, nil
}

// GrantMember enrols someone from something they carry rather than something
// an admin did: an identity-provider claim, or open mode's single org. It
// leaves an existing row entirely alone, which is what makes revocation stick
// — the claim arrives again on every sign-in, so a grant that cleared
// revoked_at would undo an admin's removal at the next login. AddMember is the
// deliberate, admin-driven counterpart that does restore.
func (o *Orgs) GrantMember(ctx context.Context, orgID, userID, role string) error {
	if role != OrgRoleAdmin && role != OrgRoleMember {
		return ErrBadRole
	}
	_, err := o.Pool.Exec(ctx, `
		insert into org_members (org_id, user_id, role) values ($1, $2, $3)
		on conflict (org_id, user_id) do nothing`,
		orgID, userID, role)
	if err != nil {
		return fmt.Errorf("granting org membership: %w", err)
	}
	return nil
}

// GrantAdmin makes someone an admin from server configuration alone: it is the
// bootstrap path, and the only way a fresh or upgraded instance mints its
// first org admin. Unlike GrantMember it promotes an existing row, because
// 0021_orgs.sql already backfilled every existing account into the default org
// as a member — leaving that row alone would make the setting inert precisely
// where it is most needed.
//
// A revoked row is still untouched, and reported as not granted. Config is a
// stronger signal than a claim, but resurrecting an account an admin
// deliberately removed is worse than refusing: whoever set the variable can
// also un-revoke on purpose.
func (o *Orgs) GrantAdmin(ctx context.Context, orgID, userID string) (bool, error) {
	var granted bool
	err := o.Pool.QueryRow(ctx, `
		insert into org_members (org_id, user_id, role) values ($1, $2, $3)
		on conflict (org_id, user_id) do update set role = excluded.role
		where org_members.revoked_at is null
		returning true`,
		orgID, userID, OrgRoleAdmin).Scan(&granted)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("granting org admin: %w", err)
	}
	return granted, nil
}

// SetClaimValue points an org at the identity-provider claim value that maps
// to it. It is the bootstrap path: without it a fresh OIDC instance has no org
// any token's claim matches, so nobody is ever a member of anything.
func (o *Orgs) SetClaimValue(ctx context.Context, slug, claimValue string) error {
	if claimValue == "" {
		return errors.New("an org's claim value may not be empty: it would match every token that lacks the claim")
	}
	tag, err := o.Pool.Exec(ctx, "update orgs set claim_value = $2 where slug = $1", slug, claimValue)
	if err != nil {
		return fmt.Errorf("setting an org claim value: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNoOrg
	}
	return nil
}
