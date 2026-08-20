package store

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
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

// twoOwners stands up a space with exactly two owners and returns both. It is
// the only shape in which the last-owner guard has anything to arbitrate:
// with one owner every mutation is refused outright, and with three there is
// slack for a race to hide in.
func twoOwners(t *testing.T, pool *pgxpool.Pool, spaces *Spaces) (Space, User, User) {
	t.Helper()
	ctx := context.Background()
	sp, first := newSpaceWithCreator(t, pool)
	second, _ := newUser(t, pool, "Second owner "+randSuffix(t))
	if err := spaces.Join(ctx, sp.ID, second.ID); err != nil {
		t.Fatal(err)
	}
	if err := spaces.SetRole(ctx, sp.ID, second.ID, RoleOwner); err != nil {
		t.Fatal(err)
	}
	return sp, first, second
}

func ownerCount(t *testing.T, pool *pgxpool.Pool, spaceID string) int {
	t.Helper()
	var n int
	err := pool.QueryRow(context.Background(),
		"select count(*) from members where space_id = $1 and role = 'owner'", spaceID).Scan(&n)
	if err != nil {
		t.Fatalf("counting owners: %v", err)
	}
	return n
}

// TestConcurrentMembershipChangesCannotStripTheLastOwner is the coverage the
// ` for update` in mutateMembership had none of. Two owners acting at the same
// instant each see the other and, without the row lock, each concludes the
// space still has a spare — both commit, and the space is left permanently
// unmanageable. Delete those two words from mutateMembership and this test
// goes red; the rest of the suite does not notice at all.
func TestConcurrentMembershipChangesCannotStripTheLastOwner(t *testing.T) {
	pool := testPool(t)
	spaces := &Spaces{Pool: pool}
	ctx := context.Background()

	demote := func(userID string) func(spaceID string) error {
		return func(spaceID string) error { return spaces.SetRole(ctx, spaceID, userID, RoleMember) }
	}
	remove := func(userID string) func(spaceID string) error {
		return func(spaceID string) error { return spaces.RemoveMember(ctx, spaceID, userID) }
	}

	pairs := []struct {
		name string
		make func(a, b User) (func(string) error, func(string) error)
	}{
		{"demote/demote", func(a, b User) (func(string) error, func(string) error) {
			return demote(a.ID), demote(b.ID)
		}},
		{"demote/remove", func(a, b User) (func(string) error, func(string) error) {
			return demote(a.ID), remove(b.ID)
		}},
		{"remove/remove", func(a, b User) (func(string) error, func(string) error) {
			return remove(a.ID), remove(b.ID)
		}},
	}

	// Not t.Run subtests: newSpaceWithCreator names the space after t.Name(),
	// and a subtest name pushes it past the 64-character check on spaces.name.
	const rounds = 60
	for _, pair := range pairs {
		for i := 0; i < rounds; i++ {
			sp, first, second := twoOwners(t, pool, spaces)
			left, right := pair.make(first, second)

			start := make(chan struct{})
			errs := make(chan error, 2)
			var wg sync.WaitGroup
			for _, fn := range []func(string) error{left, right} {
				wg.Add(1)
				go func(fn func(string) error) {
					defer wg.Done()
					<-start
					errs <- fn(sp.ID)
				}(fn)
			}
			close(start)
			wg.Wait()
			close(errs)

			succeeded := 0
			for err := range errs {
				switch {
				case err == nil:
					succeeded++
				case errors.Is(err, ErrLastOwner):
				default:
					t.Fatalf("%s round %d: unexpected error: %v", pair.name, i, err)
				}
			}
			if got := ownerCount(t, pool, sp.ID); got < 1 {
				t.Fatalf("%s round %d: space left with %d owners (succeeded=%d)", pair.name, i, got, succeeded)
			}
		}
	}
}
