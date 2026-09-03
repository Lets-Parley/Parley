package store

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The cap every test here creates against, small enough that exceeding it is
// three inserts rather than a hundred.
const testKudoCap = 3

func TestKudoRejectsItsOwnSender(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[0].ID, "thanks, me", "", testKudoCap); !errors.Is(err, ErrSelfKudo) {
		t.Fatalf("kudo to yourself: got %v, want ErrSelfKudo", err)
	}
}

// TestKudoRejectsItsOwnSender above goes through Create, which is CreateIn
// plus a transaction it owns. That already pins the guard for the common
// path, but the standup action calls CreateIn directly on a transaction it
// holds for its own reasons (internal/standup/kudos.go), and that path has
// no store-level test of its own. Assert the sentinel specifically, not just
// a 400: the membership check also fails a self-kudo (the IN-list dedups a
// repeated id down to one member), so a weaker assertion would not notice if
// the early guard were ever removed.
func TestKudoCreateInRefusesItsOwnSenderSpecifically(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	_, err = kudos.CreateIn(ctx, tx, sess.SpaceID, members[0].ID, members[0].ID, "thanks, me", "", testKudoCap)
	if !errors.Is(err, ErrSelfKudo) {
		t.Fatalf("err = %v, want ErrSelfKudo specifically (not ErrNotAMember)", err)
	}
}

func TestKudoRejectsANonMemberAndALinkGuest(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	// Somebody with a users row who never joined this space.
	outsider, _ := newUser(t, pool, "Outsider")
	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, outsider.ID, "nice work", "", testKudoCap); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("kudo to a non-member: got %v, want ErrNotAMember", err)
	}

	// And a real link guest. A guest holds a users row but no members row, so
	// the foreign key will not catch this — the membership check is the only
	// defence, and this is the test that says so.
	clearIdentityBuckets(t, pool)
	links := &Links{Pool: pool}
	link, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	_, guestToken := NewToken()
	guest, err := (&Users{Pool: pool}).CreateForLink(ctx, "Gus", link.ID, guestToken, link.ExpiresAt, LinkRedemptionCap, "10.0.0.9", 10, 500)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, guest.ID, "thanks Gus", "", testKudoCap); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("kudo to a link guest: got %v, want ErrNotAMember", err)
	}
}

func TestKudoDeleteIsTheSenderOnly(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	k, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "carried the release", "", testKudoCap)
	if err != nil {
		t.Fatal(err)
	}
	// The recipient is a member of the same space and still cannot delete it.
	if err := kudos.Delete(ctx, k.ID, members[1].ID); !errors.Is(err, ErrNoKudo) {
		t.Fatalf("delete by the recipient: got %v, want ErrNoKudo", err)
	}
	list, err := kudos.ListForSpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("after a refused delete the space has %d kudos, want 1", len(list))
	}
	if err := kudos.Delete(ctx, k.ID, members[0].ID); err != nil {
		t.Fatalf("delete by the sender: %v", err)
	}
	// A junk id is a lookup that found nothing, not a 500.
	if err := kudos.Delete(ctx, "not-a-uuid", members[0].ID); !errors.Is(err, ErrNoKudo) {
		t.Fatalf("delete of a malformed id: got %v, want ErrNoKudo", err)
	}
}

func TestKudoSurvivesTheSessionItWasGivenIn(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	k, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "unblocked me twice", sess.ID, testKudoCap)
	if err != nil {
		t.Fatal(err)
	}
	if k.SessionID != sess.ID {
		t.Fatalf("session id = %q, want %q", k.SessionID, sess.ID)
	}
	if err := (&Sessions{Pool: pool}).Delete(ctx, sess.ID, sess.SpaceID); err != nil {
		t.Fatal(err)
	}
	list, err := kudos.ListForSpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != k.ID {
		t.Fatalf("deleting the room took the kudo with it: %+v", list)
	}
	if list[0].SessionID != "" {
		t.Fatalf("session id after the room was deleted = %q, want empty", list[0].SessionID)
	}
}

func TestKudoListIsNewestFirstAndCapped(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	for _, text := range []string{"first", "second", "third"} {
		if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, text, "", testKudoCap); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, "fourth", "", testKudoCap); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("past the per-space cap: got %v, want ErrQuotaExceeded", err)
	}

	list, err := kudos.ListForSpace(ctx, sess.SpaceID)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, k := range list {
		got = append(got, k.Text)
	}
	if strings.Join(got, ",") != "third,second,first" {
		t.Fatalf("list = %v, want newest first", got)
	}
}

func TestKudoTextIsBounded(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	for _, text := range []string{"", strings.Repeat("a", 281)} {
		if _, err := kudos.Create(ctx, sess.SpaceID, members[0].ID, members[1].ID, text, "", testKudoCap); err == nil {
			t.Fatalf("a %d-character kudo was accepted", len(text))
		}
	}
}

func TestKudoRejectsANonMemberAndALinkGuestAsSender(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	sess, members := newSession(t, pool, "Ada", "Bo")
	kudos := &Kudos{Pool: pool}

	// The sending half of the same invariant: guests neither send nor receive.
	// The from_user_id foreign key points at users, not members, so it will not
	// catch either of these — the membership check is the only defence.
	outsider, _ := newUser(t, pool, "Outsider")
	if _, err := kudos.Create(ctx, sess.SpaceID, outsider.ID, members[0].ID, "nice work", "", testKudoCap); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("kudo from a non-member: got %v, want ErrNotAMember", err)
	}

	clearIdentityBuckets(t, pool)
	links := &Links{Pool: pool}
	link, _ := newLink(t, links, sess.ID, members[0].ID, LinkLifetime)
	_, guestToken := NewToken()
	guest, err := (&Users{Pool: pool}).CreateForLink(ctx, "Gus", link.ID, guestToken, link.ExpiresAt, LinkRedemptionCap, "10.0.0.9", 10, 500)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kudos.Create(ctx, sess.SpaceID, guest.ID, members[0].ID, "thanks Ada", "", testKudoCap); !errors.Is(err, ErrNotAMember) {
		t.Fatalf("kudo from a link guest: got %v, want ErrNotAMember", err)
	}
}
