package store

import (
	"context"
	"errors"
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
