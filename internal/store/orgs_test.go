package store

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestOrgsDefaultResolves(t *testing.T) {
	pool := testPool(t)
	org, err := (&Orgs{Pool: pool}).Default(context.Background())
	if err != nil {
		t.Fatalf("resolving the default org: %v", err)
	}
	if org.ID == "" || org.Slug != DefaultOrgSlug {
		t.Fatalf("default org = %+v, want a real id and the %q slug", org, DefaultOrgSlug)
	}
	if _, err := (&Orgs{Pool: pool}).BySlug(context.Background(), "no-such-org"); !errors.Is(err, ErrNoOrg) {
		t.Fatalf("BySlug on a missing org = %v, want ErrNoOrg", err)
	}
}

func TestMembershipBySlug(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgs := &Orgs{Pool: pool}
	org, err := orgs.Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := newUser(t, pool, "Ada")

	if _, _, err := orgs.MembershipBySlug(ctx, "no-such-org", u.ID); !errors.Is(err, ErrNoOrg) {
		t.Fatalf("missing org = %v, want ErrNoOrg", err)
	}
	if _, _, err := orgs.MembershipBySlug(ctx, org.Slug, u.ID); !errors.Is(err, ErrNotOrgMember) {
		t.Fatalf("outsider = %v, want ErrNotOrgMember", err)
	}

	if err := orgs.AddMember(ctx, org.ID, u.ID, OrgRoleMember); err != nil {
		t.Fatal(err)
	}
	got, role, err := orgs.MembershipBySlug(ctx, org.Slug, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != org.ID || role != OrgRoleMember {
		t.Fatalf("MembershipBySlug = %+v role=%q, want id %s role %q", got, role, org.ID, OrgRoleMember)
	}

	if _, err := pool.Exec(ctx, "update org_members set revoked_at = now() where org_id = $1 and user_id = $2", org.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := orgs.MembershipBySlug(ctx, org.Slug, u.ID); !errors.Is(err, ErrNotOrgMember) {
		t.Fatalf("revoked membership = %v, want ErrNotOrgMember", err)
	}
}

func TestOrgMembership(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgs := &Orgs{Pool: pool}
	org, err := orgs.Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := newUser(t, pool, "Ada")

	if err := orgs.AddMember(ctx, org.ID, u.ID, "wizard"); !errors.Is(err, ErrBadRole) {
		t.Fatalf("AddMember with an unknown role = %v, want ErrBadRole", err)
	}
	if err := orgs.AddMember(ctx, org.ID, u.ID, OrgRoleMember); err != nil {
		t.Fatal(err)
	}
	if member, err := orgs.IsMember(ctx, org.ID, u.ID); err != nil || !member {
		t.Fatalf("IsMember = %v, %v; want true", member, err)
	}

	if _, err := pool.Exec(ctx, "update org_members set revoked_at = now() where org_id = $1 and user_id = $2", org.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	if member, err := orgs.IsMember(ctx, org.ID, u.ID); err != nil || member {
		t.Fatalf("a revoked membership still reads as a member (%v, %v)", member, err)
	}

	// Re-adding restores the membership and re-applies the role.
	if err := orgs.AddMember(ctx, org.ID, u.ID, OrgRoleAdmin); err != nil {
		t.Fatal(err)
	}
	var role string
	if err := pool.QueryRow(ctx, "select role from org_members where org_id = $1 and user_id = $2", org.ID, u.ID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != OrgRoleAdmin {
		t.Errorf("role after re-adding = %q, want %q", role, OrgRoleAdmin)
	}
	if member, err := orgs.IsMember(ctx, org.ID, u.ID); err != nil || !member {
		t.Fatalf("re-added membership = %v, %v; want true", member, err)
	}
}

// TestSpaceSlugScopedToOrg is what the composite unique constraint buys: the
// same slug in two orgs is two different spaces, and BySlug never crosses
// between them.
func TestSpaceSlugScopedToOrg(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	defaultOrg, err := (&Orgs{Pool: pool}).Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var other string
	suffix := randSuffix(t)
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1) returning id", "other-"+suffix,
	).Scan(&other); err != nil {
		t.Fatal(err)
	}

	slug := "shared-" + suffix
	creator, _ := newUser(t, pool, "Ada")
	first, err := spaces.Create(ctx, defaultOrg.ID, "Shared", slug, "", creator.ID, VisibilityOrg, 50)
	if err != nil {
		t.Fatal(err)
	}
	second, err := spaces.Create(ctx, other, "Shared", slug, "", creator.ID, VisibilityOrg, 50)
	if err != nil {
		t.Fatalf("the same slug in a different org was refused: %v", err)
	}
	if _, err := spaces.Create(ctx, defaultOrg.ID, "Shared again", slug, "", creator.ID, VisibilityOrg, 50); !errors.Is(err, ErrSlugTaken) {
		t.Fatalf("re-using a slug within one org = %v, want ErrSlugTaken", err)
	}

	got, err := spaces.BySlug(ctx, defaultOrg.ID, slug)
	if err != nil || got.ID != first.ID {
		t.Fatalf("BySlug in the default org = %+v (%v), want %s", got, err, first.ID)
	}
	got, err = spaces.BySlug(ctx, other, slug)
	if err != nil || got.ID != second.ID {
		t.Fatalf("BySlug in the other org = %+v (%v), want %s", got, err, second.ID)
	}
}

// TestSetVisibilityIsScopedToOneSpaceID pins SetVisibility to the id it is
// given. Slugs are unique per org, not per instance, so a caller that ever
// passed a slug where an id belongs would flip the same-named space in every
// other org. Two orgs share a slug here, and only the one addressed may move.
func TestSetVisibilityIsScopedToOneSpaceID(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	defaultOrg, err := (&Orgs{Pool: pool}).Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	suffix := randSuffix(t)
	var other string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Other', $1) returning id", "other-"+suffix,
	).Scan(&other); err != nil {
		t.Fatal(err)
	}

	slug := "shared-" + suffix
	creator, _ := newUser(t, pool, "Ada")
	mine, err := spaces.Create(ctx, defaultOrg.ID, "Shared", slug, "", creator.ID, VisibilityPrivate, 50)
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := spaces.Create(ctx, other, "Shared", slug, "", creator.ID, VisibilityPrivate, 50)
	if err != nil {
		t.Fatal(err)
	}

	if err := spaces.SetVisibility(ctx, mine.ID, VisibilityOrg); err != nil {
		t.Fatal(err)
	}

	visibilityOf := func(id string) string {
		t.Helper()
		var got string
		if err := pool.QueryRow(ctx, "select visibility from spaces where id = $1", id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := visibilityOf(mine.ID); got != VisibilityOrg {
		t.Errorf("the addressed space = %q, want %q", got, VisibilityOrg)
	}
	if got := visibilityOf(theirs.ID); got != VisibilityPrivate {
		t.Fatalf("the same-slugged space in another org = %q, want %q: SetVisibility reached across orgs", got, VisibilityPrivate)
	}

	// The other half of the same guarantee: a caller that handed over a slug
	// where an id belongs must be refused, not served two spaces at once.
	if err := spaces.SetVisibility(ctx, theirs.Slug, VisibilityOrg); err == nil {
		t.Error("SetVisibility accepted a slug in place of a space id")
	}
	if got := visibilityOf(theirs.ID); got != VisibilityPrivate {
		t.Fatalf("after a slug was passed, the other org's space = %q, want %q", got, VisibilityPrivate)
	}
}

// TestSpaceCreateVisibility: open mode has to be able to force 'private'.
// Anonymous identities plus an org-visible space with no passcode would let
// any visitor join any new space.
func TestSpaceCreateVisibility(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	org, err := (&Orgs{Pool: pool}).Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{VisibilityPrivate, VisibilityOrg} {
		creator, _ := newUser(t, pool, "Ada")
		sp, err := spaces.Create(ctx, org.ID, "Vis", "vis-"+randSuffix(t), "", creator.ID, want, 50)
		if err != nil {
			t.Fatal(err)
		}
		var got string
		if err := pool.QueryRow(ctx, "select visibility from spaces where id = $1", sp.ID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("visibility = %q, want %q", got, want)
		}
	}
	creator, _ := newUser(t, pool, "Ada")
	if _, err := spaces.Create(ctx, org.ID, "Vis", "vis-"+randSuffix(t), "", creator.ID, "everyone", 50); !errors.Is(err, ErrBadVisibility) {
		t.Fatalf("an unknown visibility = %v, want ErrBadVisibility", err)
	}
}

// TestOrgsByClaimValues is the whole of claim mapping: only a value an admin
// already registered on an org matches, and an unknown one creates nothing.
func TestOrgsByClaimValues(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgs := &Orgs{Pool: pool}
	claim := "platform-" + randSuffix(t)
	var orgID string
	if err := pool.QueryRow(ctx,
		"insert into orgs (slug, name, claim_value) values ($1, 'Platform', $2) returning id", claim, claim,
	).Scan(&orgID); err != nil {
		t.Fatal(err)
	}

	got, err := orgs.ByClaimValues(ctx, []string{claim, "not-an-org-" + randSuffix(t)})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != orgID {
		t.Fatalf("ByClaimValues = %+v, want just the org carrying %q", got, claim)
	}

	// Case-sensitive: a provider group that differs only in case is a
	// different group, and matching it loosely would widen every mapping.
	if got, err := orgs.ByClaimValues(ctx, []string{strings.ToUpper(claim)}); err != nil || len(got) != 0 {
		t.Fatalf("ByClaimValues on a differently-cased value = %+v (%v), want no match", got, err)
	}
	if got, err := orgs.ByClaimValues(ctx, nil); err != nil || len(got) != 0 {
		t.Fatalf("ByClaimValues with no values = %+v (%v), want no match", got, err)
	}
	// An empty claim value must never match: the column forbids storing one,
	// and a token carrying "" is a token carrying nothing.
	if got, err := orgs.ByClaimValues(ctx, []string{""}); err != nil || len(got) != 0 {
		t.Fatalf("ByClaimValues on an empty value = %+v (%v), want no match", got, err)
	}
}

// TestGrantMemberHonoursTheTombstone is the revocation rule: a claim keeps
// arriving on every sign-in, so a grant that cleared revoked_at would undo an
// admin's removal at the revoked person's next login.
func TestGrantMemberHonoursTheTombstone(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgs := &Orgs{Pool: pool}
	org, err := orgs.Default(ctx)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := newUser(t, pool, "Ada")

	if err := orgs.GrantMember(ctx, org.ID, u.ID, OrgRoleMember); err != nil {
		t.Fatal(err)
	}
	if member, err := orgs.IsMember(ctx, org.ID, u.ID); err != nil || !member {
		t.Fatalf("IsMember after a grant = %v, %v; want true", member, err)
	}
	if err := orgs.GrantMember(ctx, org.ID, u.ID, "wizard"); !errors.Is(err, ErrBadRole) {
		t.Fatalf("GrantMember with an unknown role = %v, want ErrBadRole", err)
	}

	if _, err := pool.Exec(ctx, "update org_members set revoked_at = now() where org_id = $1 and user_id = $2", org.ID, u.ID); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := orgs.GrantMember(ctx, org.ID, u.ID, OrgRoleMember); err != nil {
			t.Fatal(err)
		}
		if member, err := orgs.IsMember(ctx, org.ID, u.ID); err != nil || member {
			t.Fatalf("a grant resurrected a revoked membership (%v, %v)", member, err)
		}
	}
	// Nor may it quietly promote: a revoked row keeps the role it was
	// revoked with.
	if err := orgs.GrantMember(ctx, org.ID, u.ID, OrgRoleAdmin); err != nil {
		t.Fatal(err)
	}
	var role string
	if err := pool.QueryRow(ctx, "select role from org_members where org_id = $1 and user_id = $2", org.ID, u.ID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != OrgRoleMember {
		t.Errorf("role after granting over a tombstone = %q, want it untouched (%q)", role, OrgRoleMember)
	}
}

// TestSetClaimValue is the bootstrap path: without it a fresh OIDC instance
// has no org whose claim any token can match.
func TestSetClaimValue(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	orgs := &Orgs{Pool: pool}
	claim := "bootstrap-" + randSuffix(t)
	if err := orgs.SetClaimValue(ctx, DefaultOrgSlug, claim); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { orgs.SetClaimValue(context.Background(), DefaultOrgSlug, DefaultOrgSlug) })

	got, err := orgs.ByClaimValues(ctx, []string{claim})
	if err != nil || len(got) != 1 || got[0].Slug != DefaultOrgSlug {
		t.Fatalf("after SetClaimValue, ByClaimValues = %+v (%v), want the default org", got, err)
	}
	if err := orgs.SetClaimValue(ctx, DefaultOrgSlug, ""); err == nil {
		t.Error("SetClaimValue accepted an empty claim, which would match every token that lacks the claim")
	}
	if err := orgs.SetClaimValue(ctx, "no-such-org", claim); !errors.Is(err, ErrNoOrg) {
		t.Fatalf("SetClaimValue on a missing org = %v, want ErrNoOrg", err)
	}
}
