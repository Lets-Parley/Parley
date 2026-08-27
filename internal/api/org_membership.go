package api

import (
	"context"
	"fmt"

	"github.com/lets-parley/parley/internal/auth"
	"github.com/lets-parley/parley/internal/store"
)

// BootstrapAdmin names the one person an operator can make an admin from
// configuration alone. It is the (issuer, subject) pair rather than a user id
// because 0009_federated_identity makes that pair the identity, and the users
// row does not exist until they first sign in. Without it a fresh OIDC
// instance is unusable: no org exists, so no claim matches, so nobody is an
// admin, so nobody can create the first org.
type BootstrapAdmin struct {
	Issuer  string
	Subject string
}

func (b BootstrapAdmin) matches(ident auth.Identity) bool {
	return b.Issuer != "" && b.Subject != "" &&
		b.Issuer == ident.Issuer && b.Subject == ident.Subject
}

// mapOrgMembership translates a completed sign-in into org membership: the
// identity provider owns who is in which team, Parley owns which orgs exist.
// Only a claim value an admin already registered on an org matches, exactly
// and case-sensitively, and an unrecognised value grants nothing rather than
// creating anything.
//
// Membership granted here never overrides a revocation tombstone: the claim
// arrives again on every sign-in, so anything else would undo an admin's
// removal at the revoked person's next login.
func (a *app) mapOrgMembership(ctx context.Context, userID string, ident auth.Identity) error {
	if a.bootstrapAdmin.matches(ident) {
		orgID, err := a.orgID(ctx)
		if err != nil {
			return fmt.Errorf("resolving the default org: %w", err)
		}
		if err := a.orgs.GrantMember(ctx, orgID, userID, store.OrgRoleAdmin); err != nil {
			return err
		}
	}
	orgs, err := a.orgs.ByClaimValues(ctx, ident.OrgClaims)
	if err != nil {
		return err
	}
	for _, org := range orgs {
		if err := a.orgs.GrantMember(ctx, org.ID, userID, store.OrgRoleMember); err != nil {
			return err
		}
	}
	return nil
}

// grantDefaultOrgMembership is open mode's whole tenancy story: one org,
// every account in it, nobody an admin.
//
// The link-guest check is the point of taking a Principal rather than a user
// id. A redeemed signed link mints an ordinary users row, so "every user"
// silently includes link guests unless something asks — and enrolling one
// would turn a capability on a single room into directory visibility over
// every org-visible space on the instance.
func (a *app) grantDefaultOrgMembership(ctx context.Context, p Principal) error {
	if p.IsLinkGuest() {
		return nil
	}
	orgID, err := a.orgID(ctx)
	if err != nil {
		return fmt.Errorf("resolving the default org: %w", err)
	}
	return a.orgs.GrantMember(ctx, orgID, p.UserID, store.OrgRoleMember)
}
