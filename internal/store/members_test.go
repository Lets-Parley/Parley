package store

import (
	"context"
	"errors"
	"testing"
)

func roleOf(t *testing.T, s *Spaces, spaceID, userID string) string {
	t.Helper()
	role, err := s.RoleOf(context.Background(), spaceID, userID)
	if err != nil {
		t.Fatalf("RoleOf: %v", err)
	}
	return role
}

func TestCreateSeatsTheCreatorAsOwner(t *testing.T) {
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	sp, creator := newSpaceWithCreator(t, pool)

	if got := roleOf(t, spaces, sp.ID, creator.ID); got != RoleOwner {
		t.Fatalf("creator role = %q, want %q", got, RoleOwner)
	}
}

func TestJoinSeatsAPlainMemberAndNeverChangesAnExistingRole(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	sp, creator := newSpaceWithCreator(t, pool)
	bob, _ := newUser(t, pool, "Bob")

	if err := spaces.Join(ctx, sp.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	if got := roleOf(t, spaces, sp.ID, bob.ID); got != RoleMember {
		t.Fatalf("joiner role = %q, want %q", got, RoleMember)
	}
	// Re-joining must not quietly reset a role — that would be a demotion
	// anyone could trigger on themselves, or on an owner, by re-knocking.
	if err := spaces.Join(ctx, sp.ID, creator.ID); err != nil {
		t.Fatal(err)
	}
	if got := roleOf(t, spaces, sp.ID, creator.ID); got != RoleOwner {
		t.Fatalf("owner role after re-join = %q, want %q", got, RoleOwner)
	}
}

func TestRosterCarriesRoles(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	sp, creator := newSpaceWithCreator(t, pool)
	bob, _ := newUser(t, pool, "Bob")
	if err := spaces.Join(ctx, sp.ID, bob.ID); err != nil {
		t.Fatal(err)
	}

	roster, err := spaces.Roster(ctx, sp.ID)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	for _, m := range roster {
		seen[m.UserID] = m.Role
	}
	if seen[creator.ID] != RoleOwner {
		t.Fatalf("roster role for the creator = %q, want %q", seen[creator.ID], RoleOwner)
	}
	if seen[bob.ID] != RoleMember {
		t.Fatalf("roster role for the joiner = %q, want %q", seen[bob.ID], RoleMember)
	}
}

func TestSetRolePromotesAndDemotes(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	sp, creator := newSpaceWithCreator(t, pool)
	bob, _ := newUser(t, pool, "Bob")
	if err := spaces.Join(ctx, sp.ID, bob.ID); err != nil {
		t.Fatal(err)
	}

	if err := spaces.SetRole(ctx, sp.ID, bob.ID, RoleOwner); err != nil {
		t.Fatalf("promote: %v", err)
	}
	if got := roleOf(t, spaces, sp.ID, bob.ID); got != RoleOwner {
		t.Fatalf("after promote role = %q, want %q", got, RoleOwner)
	}
	// With a second owner in place the creator may now step down — including
	// on themselves. Self-demotion is allowed; self-lockout is not, and the
	// second owner is what makes the difference.
	if err := spaces.SetRole(ctx, sp.ID, creator.ID, RoleMember); err != nil {
		t.Fatalf("self-demote: %v", err)
	}
	if got := roleOf(t, spaces, sp.ID, creator.ID); got != RoleMember {
		t.Fatalf("after self-demote role = %q, want %q", got, RoleMember)
	}
}

func TestSetRoleRefusesToDemoteTheLastOwner(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	sp, creator := newSpaceWithCreator(t, pool)
	bob, _ := newUser(t, pool, "Bob")
	if err := spaces.Join(ctx, sp.ID, bob.ID); err != nil {
		t.Fatal(err)
	}

	if err := spaces.SetRole(ctx, sp.ID, creator.ID, RoleMember); !errors.Is(err, ErrLastOwner) {
		t.Fatalf("demoting the last owner: got %v, want ErrLastOwner", err)
	}
	if got := roleOf(t, spaces, sp.ID, creator.ID); got != RoleOwner {
		t.Fatalf("the last owner was demoted anyway: role = %q", got)
	}
}

func TestRemoveMemberRefusesToRemoveTheLastOwner(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	sp, creator := newSpaceWithCreator(t, pool)
	bob, _ := newUser(t, pool, "Bob")
	if err := spaces.Join(ctx, sp.ID, bob.ID); err != nil {
		t.Fatal(err)
	}

	if err := spaces.RemoveMember(ctx, sp.ID, creator.ID); !errors.Is(err, ErrLastOwner) {
		t.Fatalf("removing the last owner: got %v, want ErrLastOwner", err)
	}
	if member, err := spaces.IsMember(ctx, sp.ID, creator.ID); err != nil || !member {
		t.Fatalf("the last owner was removed anyway (member=%v err=%v)", member, err)
	}
}

func TestRemoveMemberDropsMembership(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	sp, _ := newSpaceWithCreator(t, pool)
	bob, _ := newUser(t, pool, "Bob")
	if err := spaces.Join(ctx, sp.ID, bob.ID); err != nil {
		t.Fatal(err)
	}

	if err := spaces.RemoveMember(ctx, sp.ID, bob.ID); err != nil {
		t.Fatal(err)
	}
	if member, err := spaces.IsMember(ctx, sp.ID, bob.ID); err != nil || member {
		t.Fatalf("still a member after removal (member=%v err=%v)", member, err)
	}
	// A second removal is a no-op rather than a phantom success on a stranger.
	if err := spaces.RemoveMember(ctx, sp.ID, bob.ID); !errors.Is(err, ErrNotMember) {
		t.Fatalf("removing a non-member: got %v, want ErrNotMember", err)
	}
}

func TestSetRoleRejectsStrangersAndUnknownRoles(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	sp, creator := newSpaceWithCreator(t, pool)
	stranger, _ := newUser(t, pool, "Stranger")

	if err := spaces.SetRole(ctx, sp.ID, stranger.ID, RoleOwner); !errors.Is(err, ErrNotMember) {
		t.Fatalf("promoting a stranger: got %v, want ErrNotMember", err)
	}
	if err := spaces.SetRole(ctx, sp.ID, creator.ID, "admin"); !errors.Is(err, ErrBadRole) {
		t.Fatalf("unknown role: got %v, want ErrBadRole", err)
	}
	// A rejected role must not have been written on the way to the error.
	if got := roleOf(t, spaces, sp.ID, creator.ID); got != RoleOwner {
		t.Fatalf("role after a rejected write = %q, want %q", got, RoleOwner)
	}
}

func TestRoleOfAStrangerIsErrNotMember(t *testing.T) {
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	sp, _ := newSpaceWithCreator(t, pool)
	stranger, _ := newUser(t, pool, "Stranger")

	if _, err := spaces.RoleOf(context.Background(), sp.ID, stranger.ID); !errors.Is(err, ErrNotMember) {
		t.Fatalf("RoleOf(stranger): got %v, want ErrNotMember", err)
	}
}
